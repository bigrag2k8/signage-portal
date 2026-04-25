// server.js — Signage Portal (v3 — pure JS, no native modules)
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
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
});

// ── Middleware ────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory sessions (persists across requests, resets on redeploy — fine for this use case)
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// ── Helper ────────────────────────────────────────────────
const sendHTML = (res, file) =>
  res.sendFile(path.join(__dirname, 'public', file));

// ════════════════════════════════════════════════════════
//  CLIENT ROUTES
// ════════════════════════════════════════════════════════

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

app.get('/portal', requireClient, (req, res) => sendHTML(res, 'portal.html'));

// API: get client's assigned screens from Yodeck
app.get('/api/screens', requireClient, async (req, res) => {
  try {
    const client = db.getClient(req.session.clientId);
    if (!client || !client.yodeck_token) {
      return res.json({ error: 'No Yodeck token configured for your account. Please contact support.' });
    }

    const assignedIds = JSON.parse(client.assigned_screens || '[]');
    const allScreens = await yodeck.getScreens(client.yodeck_token);

    const screens = assignedIds.length > 0
      ? allScreens.filter(s => assignedIds.includes(String(s.id)))
      : allScreens;

    res.json({ screens });
  } catch (err) {
    console.error('Screens error:', err.message);
    res.status(500).json({ error: 'Could not load screens. Check your Yodeck token.' });
  }
});

// API: upload + publish
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
    // 1. Upload media to Yodeck
    const media = await yodeck.uploadMedia(
      client.yodeck_token,
      file.buffer,
      file.originalname,
      file.mimetype,
      displayName || file.originalname
    );

    // 2. Add to each selected screen's playlist
    for (const screenId of ids) {
      await yodeck.addMediaToScreen(client.yodeck_token, screenId, media.id, parseInt(duration) || 10);
    }

    // 3. Resolve screen names for the log
    const allScreens = await yodeck.getScreens(client.yodeck_token);
    const nameMap = {};
    allScreens.forEach(s => { nameMap[String(s.id)] = s.name; });
    const resolvedNames = ids.map(id => nameMap[id] || id).join(', ');

    // 4. Log to DB
    db.logPublish({
      client_id: client.id,
      client_name: client.name,
      filename: file.originalname,
      screen_names: resolvedNames
    });

    // 5. Email notification (non-fatal)
    try {
      await sendPublishNotification({
        clientName: client.name,
        clientEmail: client.email,
        filename: file.originalname,
        screenNames: resolvedNames,
        publishedAt: new Date().toLocaleString()
      });
    } catch (mailErr) {
      console.warn('Email failed (non-fatal):', mailErr.message);
    }

    res.json({
      success: true,
      message: `"${displayName || file.originalname}" published to: ${resolvedNames}`
    });
  } catch (err) {
    console.error('Publish error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Publish failed: ' + (err.response?.data?.detail || err.message) });
  }
});

// ════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════════════════════════════

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
app.get('/admin', requireAdmin, (req, res) => sendHTML(res, 'admin.html'));

// Admin API: list clients (omit passwords)
app.get('/admin/api/clients', requireAdmin, (req, res) => {
  const clients = db.getAllClients().map(c => {
    const { password, ...safe } = c;
    return safe;
  });
  res.json(clients);
});

// Admin API: create client
app.post('/admin/api/clients', requireAdmin, async (req, res) => {
  const { name, email, username, password, yodeck_token, assigned_screens } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required.' });

  // Check for duplicate username/email
  const all = db.getAllClients();
  if (all.find(c => c.username === username)) return res.status(400).json({ error: 'Username already exists.' });
  if (all.find(c => c.email === email)) return res.status(400).json({ error: 'Email already exists.' });

  const hashed = await bcrypt.hash(password, 10);
  const result = db.createClient({ name, email, username, password: hashed, yodeck_token, assigned_screens });

  try {
    await sendWelcomeEmail({ clientName: name, clientEmail: email, username, password });
  } catch (e) {
    console.warn('Welcome email failed:', e.message);
  }

  res.json({ id: result.lastInsertRowid, name, email, username });
});

// Admin API: update client
app.put('/admin/api/clients/:id', requireAdmin, async (req, res) => {
  const { name, email, username, password, yodeck_token, assigned_screens, active } = req.body;
  let hashedPassword = null;
  if (password) hashedPassword = await bcrypt.hash(password, 10);

  db.updateClient(req.params.id, {
    name, email, username,
    password: hashedPassword,
    yodeck_token,
    assigned_screens,
    active
  });
  res.json({ success: true });
});

// Admin API: delete client
app.delete('/admin/api/clients/:id', requireAdmin, (req, res) => {
  db.deleteClient(req.params.id);
  res.json({ success: true });
});

// Admin API: activity log
app.get('/admin/api/log', requireAdmin, (req, res) => {
  res.json(db.getLog(100));
});

// Admin API: verify Yodeck token
app.post('/admin/api/verify-token', requireAdmin, async (req, res) => {
  const { token } = req.body;
  const valid = await yodeck.verifyToken(token);
  res.json({ valid });
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Signage Portal running on port ${PORT}`);
  console.log(`   Client portal: http://localhost:${PORT}/login`);
  console.log(`   Admin panel:   http://localhost:${PORT}/admin`);
});
