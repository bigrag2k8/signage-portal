require('dotenv').config();
var express = require('express');
var session = require('express-session');
var FileStore = require('session-file-store')(session);
var bcrypt = require('bcryptjs');
var multer = require('multer');
var path = require('path');

var db = require('./db');
var yodeck = require('./yodeck');
var mailer = require('./mailer');
var auth = require('./middleware/auth');

var app = express();
var PUBLIC = path.join(__dirname, 'public');

var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: new FileStore({ path: process.env.SESSION_PATH || './sessions', ttl: 28800, retries: 0 }),
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

function sendHTML(res, file) {
  res.sendFile(path.join(PUBLIC, file));
}

// ── Client routes ─────────────────────────────────────────

app.get('/', function(req, res) { res.redirect('/login'); });

app.get('/login', function(req, res) { sendHTML(res, 'login.html'); });

app.post('/login', function(req, res) {
  var username = req.body.username;
  var password = req.body.password;
  var client = db.getClientByUsername(username);
  if (!client) return res.redirect('/login?error=1');
  bcrypt.compare(password, client.password, function(err, ok) {
    if (!ok) return res.redirect('/login?error=1');
    req.session.clientId = client.id;
    req.session.clientName = client.name;
    res.redirect('/portal');
  });
});

app.get('/logout', function(req, res) {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/portal', auth.requireClient, function(req, res) {
  sendHTML(res, 'portal.html');
});

app.get('/api/screens', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) {
    return res.json({ error: 'No Yodeck token configured. Please contact support.' });
  }
  var assignedIds = JSON.parse(client.assigned_screens || '[]');
  yodeck.getScreens(client.yodeck_token).then(function(allScreens) {
    var screens = assignedIds.length > 0
      ? allScreens.filter(function(s) { return assignedIds.indexOf(String(s.id)) !== -1; })
      : allScreens;
    // Normalize screen data for the portal
    var normalized = screens.map(function(s) {
      return {
        id: s.id,
        name: s.name,
        online: s.state && s.state.online === true,
        updating: s.state && s.state.updating === true,
        last_seen: s.state && s.state.last_seen,
        screenshot_url: s.screenshot_url || null,
        last_pushed: s.last_pushed
      };
    });
    res.json({ screens: normalized });
  }).catch(function(err) {
    console.error('Screens error:', err.message);
    res.status(500).json({ error: 'Could not load screens. Check your Yodeck token.' });
  });
});

app.post('/api/publish', auth.requireClient, upload.single('file'), function(req, res) {
  var file = req.file;
  var screenIds = req.body.screenIds;
  var duration = req.body.duration;
  var displayName = req.body.displayName;

  if (!file) return res.status(400).json({ error: 'No file uploaded.' });
  if (!screenIds) return res.status(400).json({ error: 'No screens selected.' });

  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) {
    return res.status(400).json({ error: 'No Yodeck token configured. Please contact support.' });
  }

  var ids = Array.isArray(screenIds) ? screenIds : [screenIds];
  var token = client.yodeck_token;
  var dur = parseInt(duration) || 10;

  yodeck.publishToScreens(token, ids, file.buffer, file.originalname, file.mimetype, displayName || file.originalname, dur)
    .then(function(result) {
      return yodeck.getScreens(token).then(function(allScreens) {
        var nameMap = {};
        allScreens.forEach(function(s) { nameMap[String(s.id)] = s.name; });
        var resolvedNames = ids.map(function(id) { return nameMap[id] || id; }).join(', ');

        db.logPublish({
          client_id: client.id,
          client_name: client.name,
          filename: file.originalname,
          screen_names: resolvedNames
        });

        mailer.sendPublishNotification({
          clientName: client.name,
          clientEmail: client.email,
          filename: file.originalname,
          screenNames: resolvedNames,
          publishedAt: new Date().toLocaleString()
        }).catch(function(e) { console.warn('Email failed:', e.message); });

        res.json({ success: true, message: '"' + (displayName || file.originalname) + '" added to playlist on: ' + resolvedNames });
      });
    })
    .catch(function(err) {
      console.error('Publish error:', err.response ? JSON.stringify(err.response.data) : err.message);
      res.status(500).json({ error: 'Publish failed: ' + (err.response ? JSON.stringify(err.response.data) : err.message) });
    });
});

// ── Admin routes ──────────────────────────────────────────

app.get('/admin/login', function(req, res) { sendHTML(res, 'admin-login.html'); });

app.post('/admin/login', function(req, res) {
  if (req.body.username === process.env.ADMIN_USERNAME && req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

app.get('/admin/logout', function(req, res) {
  req.session.destroy();
  res.redirect('/admin/login');
});

app.get('/admin', auth.requireAdmin, function(req, res) { sendHTML(res, 'admin.html'); });

app.get('/admin/api/clients', auth.requireAdmin, function(req, res) {
  var clients = db.getAllClients().map(function(c) {
    return { id: c.id, name: c.name, email: c.email, username: c.username, yodeck_token: c.yodeck_token, assigned_screens: c.assigned_screens, active: c.active, created_at: c.created_at };
  });
  res.json(clients);
});

app.post('/admin/api/clients', auth.requireAdmin, function(req, res) {
  var data = req.body;
  if (!data.password) return res.status(400).json({ error: 'Password is required.' });
  var all = db.getAllClients();
  if (all.find(function(c) { return c.username === data.username; })) return res.status(400).json({ error: 'Username already exists.' });
  if (all.find(function(c) { return c.email === data.email; })) return res.status(400).json({ error: 'Email already exists.' });

  bcrypt.hash(data.password, 10, function(err, hashed) {
    var result = db.createClient({
      name: data.name,
      email: data.email,
      username: data.username,
      password: hashed,
      yodeck_token: data.yodeck_token,
      assigned_screens: data.assigned_screens
    });
    mailer.sendWelcomeEmail({ clientName: data.name, clientEmail: data.email, username: data.username, password: data.password })
      .catch(function(e) { console.warn('Welcome email failed:', e.message); });
    res.json({ id: result.lastInsertRowid, name: data.name, email: data.email, username: data.username });
  });
});

app.put('/admin/api/clients/:id', auth.requireAdmin, function(req, res) {
  var data = req.body;
  var id = req.params.id;
  if (data.password) {
    bcrypt.hash(data.password, 10, function(err, hashed) {
      db.updateClient(id, { name: data.name, email: data.email, username: data.username, password: hashed, yodeck_token: data.yodeck_token, assigned_screens: data.assigned_screens, active: data.active });
      res.json({ success: true });
    });
  } else {
    db.updateClient(id, { name: data.name, email: data.email, username: data.username, password: null, yodeck_token: data.yodeck_token, assigned_screens: data.assigned_screens, active: data.active });
    res.json({ success: true });
  }
});

app.delete('/admin/api/clients/:id', auth.requireAdmin, function(req, res) {
  db.deleteClient(req.params.id);
  res.json({ success: true });
});

app.get('/admin/api/log', auth.requireAdmin, function(req, res) {
  res.json(db.getLog(100));
});

app.post('/admin/api/verify-token', auth.requireAdmin, function(req, res) {
  yodeck.verifyToken(req.body.token).then(function(result) {
    res.json(result);
  });
});

// ── Playlist management routes ────────────────────────────

// Get playlist for a specific screen
app.get('/api/playlist/:screenId', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) {
    return res.status(400).json({ error: 'No Yodeck token configured.' });
  }
  yodeck.getScreenPlaylist(client.yodeck_token, req.params.screenId).then(function(data) {
    res.json(data);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// Remove an item from a playlist
app.delete('/api/playlist/:playlistId/item/:mediaId', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) {
    return res.status(400).json({ error: 'No Yodeck token configured.' });
  }
  yodeck.removeItemFromPlaylist(client.yodeck_token, req.params.playlistId, req.params.mediaId).then(function() {
    res.json({ success: true });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// Update playlist items (for duration changes)
app.post('/api/playlist/:playlistId/update', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) return res.status(400).json({ error: 'No token.' });
  var items = req.body.items || [];
  yodeck.updatePlaylist(client.yodeck_token, req.params.playlistId, items).then(function() {
    res.json({ success: true });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// ── Static files (after all routes) ──────────────────────
app.use(express.static(PUBLIC));

// ── 404 ───────────────────────────────────────────────────
app.use(function(req, res) {
  res.status(404).send('<html><body style="font-family:sans-serif;padding:40px;background:#0a0a0f;color:#f1f1f3"><h2>Page not found</h2><p><a href="/login" style="color:#6366f1">/login</a> &nbsp;|&nbsp; <a href="/admin/login" style="color:#6366f1">/admin/login</a></p></body></html>');
});

// ── Start ─────────────────────────────────────────────────
var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Signage Portal running on port ' + PORT);
  console.log('Client login:  /login');
  console.log('Admin login:   /admin/login');
});
