// server.js — Signage Portal main server
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

const SqliteStore = require('connect-sqlite3')(session);
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: new SqliteStore({ db: 'sessions.db', dir: __dirname }),
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

app.set('view engine', 'html');

// ── Helper: send HTML file ────────────────────────────────
const sendHTML = (res, file) =>
  res.sendFile(path.join(__dirname, 'public', file));

// ════════════════════════════════════════════════════════
//  CLIENT ROUTES
// ════════════════════════════════════════════════════════

// Login page
app.get('/login', (req, res) => sendHTML(res, 'login.html'));
app.get('/', (req, res) => res.redirect('/login'));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const client = db.prepare('SELECT * FROM clients WHERE username = ? AND active = 1').get(username);
  if (!client) return res.redirect('/login?error=1');
  const ok = await bcrypt.compare(password, client.password);
  if (!ok) return res.redirect('/login?error=1');
  req.session.clientId = client.id;
  req.session.clientName = client.name;
  res.redirect('/portal');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Main upload portal
app.get('/portal', requireClient, (req, res) => sendHTML(res, 'portal.html'));

// API: get client's assigned screens from Yodeck
app.get('/api/screens', requireClient, async (req, res) => {
  try {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.session.clientId);
    if (!client.yodeck_token) {
      return res.json({ error: 'No Yodeck token configured for your account. Please contact support.' });
    }

    const assignedIds = JSON.parse(client.assigned_screens || '[]');
    const allScreens = await yodeck.getScreens(client.yodeck_token);

    // Filter to only assigned screens (or show all if none assigned)
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

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.session.clientId);
  if (!client.yodeck_token) {
    return res.status(400).json({ error: 'No Yodeck token configured. Please contact support.' });
  }

  const ids = Array.isArray(screenIds) ? screenIds : [screenIds];

  try {
    // 1. Upload media to Yodeck
    res.write && res.flushHeaders && res.flushHeaders();

    const media = await yodeck.uploadMedia(
      client.yodeck_token,
      file.buffer,
      file.originalname,
      file.mimetype,
      displayName || file.originalname
    );

    // 2. Add to each screen's playlist
    const screenNames = [];
    for (const screenId of ids) {
      await yodeck.addMediaToScreen(client.yodeck_token, screenId, media.id, parseInt(duration) || 10);
      screenNames.push(screenId);
    }

    // 3. Resolve screen names
    const allScreens = await yodeck.getScreens(client.yodeck_token);
    const nameMap = {};
    allScreens.forEach(s => { nameMap[String(s.id)] = s.name; });
    const resolvedNames = ids.map(id => nameMap[id] || id).join(', ');

    // 4. Log to DB
    db.prepare(`
      INSERT INTO publish_log (client_id, client_name, filename, screen_names)
      VALUES (?, ?, ?, ?)
    `).run(client.id, client.name, file.originalname, resolvedNames);

    // 5. Send email notification
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

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

app.get('/admin', requireAdmin, (req, res) => sendHTML(res, 'admin.html'));

// Admin API: list clients
app.get('/admin/api/clients', requireAdmin, (req, res) => {
  const clients = db.prepare('SELECT id, name, email, username, yodeck_token, assigned_screens, active, created_at FROM clients ORDER BY created_at DESC').all();
  res.json(clients);
});

// Admin API: create client
app.post('/admin/api/clients', requireAdmin, async (req, res) => {
  const { name, email, username, password, yodeck_token, assigned_screens } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  try {
    const stmt = db.prepare(`
      INSERT INTO clients (name, email, username, password, yodeck_token, assigned_screens)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(name, email, username, hashed, yodeck_token || null, JSON.stringify(assigned_screens || []));

    // Send welcome email
    try {
      await sendWelcomeEmail({ clientName: name, clientEmail: email, username, password });
    } catch (e) {
      console.warn('Welcome email failed:', e.message);
    }

    res.json({ id: result.lastInsertRowid, name, email, username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin API: update client
app.put('/admin/api/clients/:id', requireAdmin, async (req, res) => {
  const { name, email, username, password, yodeck_token, assigned_screens, active } = req.body;
  let hashed = undefined;
  if (password) hashed = await bcrypt.hash(password, 10);

  const fields = ['name=?', 'email=?', 'username=?', 'yodeck_token=?', 'assigned_screens=?', 'active=?'];
  const values = [name, email, username, yodeck_token || null, JSON.stringify(assigned_screens || []), active ? 1 : 0];

  if (hashed) {
    fields.push('password=?');
    values.push(hashed);
  }
  values.push(req.params.id);

  db.prepare(`UPDATE clients SET ${fields.join(',')} WHERE id=?`).run(...values);
  res.json({ success: true });
});

// Admin API: delete client
app.delete('/admin/api/clients/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM clients WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Admin API: activity log
app.get('/admin/api/log', requireAdmin, (req, res) => {
  const log = db.prepare('SELECT * FROM publish_log ORDER BY published_at DESC LIMIT 100').all();
  res.json(log);
});

// Admin API: verify a Yodeck token
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
