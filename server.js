// server.js — Signage Portal (v4 — routes before static to prevent conflicts)
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');

const db = require('./db');
const yodeck = require('./yodeck');
const { sendPublishNotification, sendWelcomeEmail } = require('./mailer');
const { requireClient, requireAdmin } = require('./middleware/auth');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

// ── Body parsing ──────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Sessions (file-based store — production safe, pure JS) ──
const FileStore = require('session-file-store')(session);
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: new FileStore({ path: './sessions', ttl: 28800, retries: 0 }),
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// ── HTML helper ───────────────────────────────────────────
const PUBLIC = path.join(__dirname, 'public');
const sendHTML = (res, file) => res.sendFile(path.join(PUBLIC, file));

// ════════════════════════════════════════════════════════
//  ALL ROUTES (defined BEFORE static middleware)
// ════════════════════════════════════════════════════════

// ── Client auth ───────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/login'));

app.get('/login', (req, res) => sendHTML(res, 'login.html'));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const client = db.getClientByUsername(username);
  if (!client) return res.redirect('/login?error=1');
  const ok = await bcrypt.compare(password, client.password);
  if (!ok) return res.redirect('/login?error=1');
  req.session.clientId = client.id;
  req.session.clientName = client.name;
  res.redirect('/portal');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ── Client portal ─────────────────────────────────────────
app.get('/portal', requireClient, (req, res) => sendHTML(res, 'portal.html'));

app.get('/api/screens', requireClient, async (req, res) => {
  try {
    const client = db.getClient(req.session.clientId);
    if (!client || !client.yodeck_token) {
      return res.json({ error: 'No Yodeck token configured. Please contact support.' });
    }
    const assignedIds = JSON.parse(client.assigned_screens || '[]');
    const allScreens = await yodeck.getScreens(client.yodeck_token);
    const screens = assignedIds.length > 0
      ? allScreens.filter(s => assignedIds.includes(String(s.id)))
      : allScreens;
    res.json({ screens });
  } catch (err) {
    console.error('Screens error:', err.message);
    res.status(500).json({ error: 'Could not load screens. Check Yodeck token.' });
  }
});

app.post('/api/publish', requireClient, upload.single('file'), async (req, res) => {
  const { screenIds, duration, displayName } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded.' });
  if (!screenIds) return res.status(400).json({ error: 'No screens selected.' });

  const client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) {
    return res.status(400).json({ error: 'No Yodeck token configured. Please contact support.' });
  }

  const ids = Array.isArray(screenIds) ? screenIds : [screenIds];

  try {
    const media = await yodeck.uploadMedia(
      client.yodeck_token, file.buffer, file.originalname, file.mimetype,
      displayName || file.originalname
    );
    for (const screenId of ids) {
      await yodeck.addMediaToScreen(client.yodeck_token, screenId, media.id, parseInt(duration) || 10);
    }
    const allScreens = await yodeck.getScreens(client.yodeck_token);
    const nameMap = {};
    allScreens.forEach(s => { nameMap[String(s.id)] = s.name; });
    const resolvedNames = ids.map(id => nameMap[id] || id).join(', ');

    db.logPublish({ client_id: client.id, client_name: client.name, filename: file.originalname, screen_names: resolvedNames });

    try {
      await sendPublishNotification({
        clientName: client.name, clientEmail: client.email,
        filename: file.originalname, screenNames: resolvedNames,
        publishedAt: new Date().toLocaleString()
      });
    } catch (e) { console.warn('Email failed:', e.message); }

    res.json({ success: true, message: `"${displayName || file.originalname}" published to: ${resolvedNames}` });
  } catch (err) {
    console.error('Publish error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Publish failed: ' + (err.response?.data?.detail || err.message) });
  }
});

// ── Admin auth ────────────────────────────────────────────
app.get('/admin/login', (req, res) => sendHTML(res, 'admin-login.html'));

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

// ── Admin dashboard ───────────────────────────────────────
app.get('/admin', requireAdmin, (req, res) => sendHTML(res, 'admin.html'));

app.get('/admin/api/clients', requireAdmin, (req, res) => {
  const clients = db.getAllClients().map(({ password, ...safe }) => safe);
  res.json(clients);
});

app.post('/admin/api/clients', requireAdmin, async (req, res) => {
  const { name, email, username, password, yodeck_token, assigned_screens } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required.' });
  const all = db.getAllClients();
  if (all.find(c => c.username === username)) return res.status(400).json({ error: 'Username already exists.' });
  if (all.find(c => c.email === email)) return res.status(400).json({ error: 'Email already exists.' });

  const hashed = await bcrypt.hash(password, 10);
  const result = db.createClient({ name, email, username, password: hashed, yodeck_token, assigned_screens });

  try { await sendWelcomeEmail({ clientName: name, clientEmail: email, username, password }); }
  catch (e) { console.warn('Welcome email failed:', e.message); }

  res.json({ id: result.lastInsertRowid, name, email, username });
});

app.put('/admin/api/clients/:id', requireAdmin, async (req, res) => {
  const { name, email, username, password, yodeck_token, assigned_screens, active } = req.body;
  const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
  db.updateClient(req.params.id, { name, email, username, password: hashedPassword, yodeck_token, assigned_screens, active });
  res.json({ success: true });
});

app.delete('/admin/api/clients/:id', requireAdmin, (req, res) => {
  db.deleteClient(req.params.id);
  res.json({ success: true });
});

app.get('/admin/api/log', requireAdmin, (req, res) => res.json(db.getLog(100)));

app.post('/admin/api/verify-token', requireAdmin, async (req, res) => {
  const { token } = req.body;
  const valid = await yodeck.verifyToken(token);
  res.json({ valid });
});

// ── Static files (AFTER all routes) ──────────────────────
app.use(express.static(PUBLIC));

// ── 404 fallback ──────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send(`
    <html><body style="font-family:sans-serif;padding:40px;background:#0a0a0f;color:#f1f1f3">
      <h2>Page not found</h2>
      <p>Try <a href="/login" style="color:#6366f1">/login</a> or <a href="/admin/login" style="color:#6366f1">/admin/login</a></p>
    </body></html>
  `);
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Signage Portal v4 running on port ${PORT}`);
  console.log(`   Client login: http://localhost:${PORT}/login`);
  console.log(`   Admin login:  http://localhost:${PORT}/admin/login`);
});
