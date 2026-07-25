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
// PUBLIC is served to anyone; VIEWS is not served directly, only via guarded routes.
var PUBLIC = path.join(__dirname, 'public');
var VIEWS = path.join(__dirname, 'views');

// Trust Railway's reverse proxy for accurate IP detection
app.set('trust proxy', 1);

var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

// Saved designs post their canvas as JSON with images embedded as data URLs,
// which the 100kb default would reject outright.
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: new FileStore({ path: process.env.SESSION_PATH || './sessions', ttl: 28800, retries: 0 }),
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// ── Account lockout tracking ──────────────────────────────
var loginAttempts = {};
var LOCKOUT_LIMIT = 5;
var LOCKOUT_MINUTES = 15;

function getAttempts(username) {
  var key = username.toLowerCase();
  if (!loginAttempts[key]) loginAttempts[key] = { count: 0, lockedUntil: null };
  return loginAttempts[key];
}

function recordFailedAttempt(username) {
  var a = getAttempts(username);
  a.count++;
  if (a.count >= LOCKOUT_LIMIT) {
    a.lockedUntil = Date.now() + (LOCKOUT_MINUTES * 60 * 1000);
    console.log('Account locked:', username);
  }
}

function resetAttempts(username) {
  loginAttempts[username.toLowerCase()] = { count: 0, lockedUntil: null };
}

function isLocked(username) {
  var a = getAttempts(username);
  if (a.lockedUntil && Date.now() < a.lockedUntil) return true;
  if (a.lockedUntil && Date.now() >= a.lockedUntil) resetAttempts(username);
  return false;
}

function sendHTML(res, file) {
  res.sendFile(path.join(VIEWS, file));
}

// ════════════════════════════════════════════════════════
//  CLIENT ROUTES
// ════════════════════════════════════════════════════════

app.get('/', function(req, res) { res.redirect('/login'); });
app.get('/login', function(req, res) { sendHTML(res, 'login.html'); });

app.post('/login', function(req, res) {
  var username = (req.body.username || '').trim();
  var password = req.body.password;

  if (isLocked(username)) return res.redirect('/login?error=locked');

  var client = db.getClientByUsername(username);
  if (!client) {
    recordFailedAttempt(username);
    return res.redirect('/login?error=1&attempts=' + getAttempts(username).count);
  }

  bcrypt.compare(password, client.password, function(err, ok) {
    if (!ok) {
      recordFailedAttempt(username);
      var a = getAttempts(username);
      if (a.lockedUntil) return res.redirect('/login?error=locked');
      return res.redirect('/login?error=1&attempts=' + a.count);
    }
    resetAttempts(username);
    req.session.clientId = client.id;
    req.session.clientName = client.name;
    if (client.must_change_password) return res.redirect('/change-password');
    res.redirect('/portal');
  });
});

app.get('/logout', function(req, res) { req.session.destroy(); res.redirect('/login'); });

// ── Force password change ─────────────────────────────────
app.get('/change-password', auth.requireClient, function(req, res) {
  sendHTML(res, 'change-password.html');
});

app.post('/change-password', auth.requireClient, function(req, res) {
  var newPassword = req.body.newPassword;
  var confirmPassword = req.body.confirmPassword;
  if (!newPassword || newPassword.length < 8) return res.redirect('/change-password?error=short');
  if (newPassword !== confirmPassword) return res.redirect('/change-password?error=mismatch');

  var client = db.getClient(req.session.clientId);
  bcrypt.hash(newPassword, 10, function(err, hashed) {
    db.updateClientPassword(client.id, hashed, false);
    res.redirect('/portal');
  });
});

// ── Client portal ─────────────────────────────────────────
app.get('/portal', auth.requireClient, function(req, res) { sendHTML(res, 'portal.html'); });

// ── Slide designer ────────────────────────────────────────
app.get('/editor', auth.requireClient, function(req, res) { sendHTML(res, 'editor.html'); });

app.get('/api/screens', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) return res.json({ error: 'No Yodeck token configured. Please contact support.' });
  var assignedIds = JSON.parse(client.assigned_screens || '[]');
  yodeck.getScreens(client.yodeck_token).then(function(allScreens) {
    var screens = assignedIds.length > 0
      ? allScreens.filter(function(s) { return assignedIds.indexOf(String(s.id)) !== -1; })
      : allScreens;
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
    res.status(500).json({ error: 'Could not load screens.' });
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
  if (!client || !client.yodeck_token) return res.status(400).json({ error: 'No Yodeck token configured.' });

  var ids = Array.isArray(screenIds) ? screenIds : [screenIds];
  var token = client.yodeck_token;
  var dur = parseInt(duration) || 10;

  yodeck.publishToScreens(token, ids, file.buffer, file.originalname, file.mimetype, displayName || file.originalname, dur)
    .then(function() {
      return yodeck.getScreens(token).then(function(allScreens) {
        var nameMap = {};
        allScreens.forEach(function(s) { nameMap[String(s.id)] = s.name; });
        var resolvedNames = ids.map(function(id) { return nameMap[id] || id; }).join(', ');
        db.logPublish({ client_id: client.id, client_name: client.name, filename: file.originalname, screen_names: resolvedNames });
        mailer.sendPublishNotification({ clientName: client.name, clientEmail: client.email, filename: file.originalname, screenNames: resolvedNames, publishedAt: new Date().toLocaleString() })
          .catch(function(e) { console.warn('Email failed:', e.message); });
        res.json({ success: true, message: '"' + (displayName || file.originalname) + '" added to playlist on: ' + resolvedNames });
      });
    })
    .catch(function(err) {
      console.error('Publish error:', err.response ? JSON.stringify(err.response.data) : err.message);
      res.status(500).json({ error: 'Publish failed: ' + (err.response ? JSON.stringify(err.response.data) : err.message) });
    });
});

// ── Playlist routes ───────────────────────────────────────
app.get('/api/playlist/:screenId', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) return res.status(400).json({ error: 'No token.' });
  yodeck.getScreenPlaylist(client.yodeck_token, req.params.screenId).then(function(data) {
    res.json(data);
  }).catch(function(err) { res.status(500).json({ error: err.message }); });
});

app.delete('/api/playlist/:playlistId/item/:mediaId', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) return res.status(400).json({ error: 'No token.' });
  yodeck.removeItemFromPlaylist(client.yodeck_token, req.params.playlistId, req.params.mediaId).then(function() {
    res.json({ success: true });
  }).catch(function(err) { res.status(500).json({ error: err.message }); });
});

app.post('/api/push/:screenId', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) return res.status(400).json({ error: 'No token.' });
  yodeck.pushToScreen(client.yodeck_token, req.params.screenId).then(function() {
    res.json({ success: true });
  }).catch(function(err) {
    console.error('Push error:', err.response ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: err.message });
  });
});

app.post('/api/playlist/:playlistId/update', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) return res.status(400).json({ error: 'No token.' });
  yodeck.updatePlaylist(client.yodeck_token, req.params.playlistId, req.body.items || []).then(function() {
    res.json({ success: true });
  }).catch(function(err) { res.status(500).json({ error: err.message }); });
});

app.get('/api/screen/:screenId', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) return res.status(400).json({ error: 'No token.' });
  yodeck.getScreens(client.yodeck_token).then(function(screens) {
    var screen = screens.find(function(s) { return String(s.id) === String(req.params.screenId); });
    if (!screen) return res.status(404).json({ error: 'Screen not found.' });
    res.json({ id: screen.id, name: screen.name, online: screen.state && screen.state.online === true, screenshot_url: screen.screenshot_url || null });
  }).catch(function(e) { res.status(500).json({ error: e.message }); });
});

// ── Saved designs ─────────────────────────────────────────
// Designs belong to a company, so everyone at that company shares the library.

var MAX_DESIGN_BYTES = 8 * 1024 * 1024;
var MAX_DESIGNS_PER_COMPANY = 300;

// Resolves the design only if it belongs to the caller's company. Answers 404
// rather than 403 for someone else's design so ids cannot be probed.
function findOwnedDesign(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client) { res.status(401).json({ error: 'Not signed in.' }); return null; }
  var design = db.getDesign(req.params.id);
  if (!design || design.company_id !== client.company_id) {
    res.status(404).json({ error: 'Design not found.' });
    return null;
  }
  return { client: client, design: design };
}

// Pulls the canvas payload and thumbnail out of a request, rejecting anything
// oversized or malformed before it reaches disk.
function readDesignBody(req, res) {
  var name = (req.body.name || '').trim();
  if (!name) { res.status(400).json({ error: 'Give the design a name.' }); return null; }
  if (name.length > 120) { res.status(400).json({ error: 'That name is too long.' }); return null; }
  if (!req.body.payload || typeof req.body.payload !== 'object' || !req.body.payload.canvas) {
    res.status(400).json({ error: 'Design data missing or unreadable.' });
    return null;
  }
  if (Buffer.byteLength(JSON.stringify(req.body.payload)) > MAX_DESIGN_BYTES) {
    res.status(413).json({ error: 'This design is too large to save. Try a smaller background image.' });
    return null;
  }
  var thumb = null;
  var raw = req.body.thumb;
  if (typeof raw === 'string' && raw.indexOf('data:image/png;base64,') === 0) {
    thumb = Buffer.from(raw.slice('data:image/png;base64,'.length), 'base64');
    if (thumb.length > 1024 * 1024) thumb = null; // preview only; skip if oversized
  }
  return { name: name, payload: req.body.payload, thumb: thumb };
}

app.get('/api/designs', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ designs: db.getDesignsByCompany(client.company_id) });
});

app.get('/api/designs/:id', auth.requireClient, function(req, res) {
  var found = findOwnedDesign(req, res);
  if (!found) return;
  var payload = db.readDesignCanvas(found.design.id);
  if (!payload) return res.status(500).json({ error: 'This design could not be opened. Its data may be damaged.' });
  res.json({ design: found.design, payload: payload });
});

app.get('/api/designs/:id/thumb', auth.requireClient, function(req, res) {
  var found = findOwnedDesign(req, res);
  if (!found) return;
  var buf = db.readDesignThumb(found.design.id);
  if (!buf) return res.status(404).end();
  res.type('png').send(buf);
});

app.post('/api/designs', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client) return res.status(401).json({ error: 'Not signed in.' });
  if (db.countDesignsForCompany(client.company_id) >= MAX_DESIGNS_PER_COMPANY) {
    return res.status(400).json({ error: 'You have reached the limit of ' + MAX_DESIGNS_PER_COMPANY + ' saved designs. Delete one first.' });
  }
  var body = readDesignBody(req, res);
  if (!body) return;
  try {
    var design = db.createDesign({
      company_id: client.company_id,
      user_id: client.id,
      user_name: client.username,
      name: body.name,
      orientation: req.body.payload.orientation,
      payload: body.payload,
      thumb: body.thumb
    });
    res.json({ success: true, design: design });
  } catch (e) {
    console.error('Design save failed:', e.message);
    res.status(500).json({ error: 'Could not save the design.' });
  }
});

app.put('/api/designs/:id', auth.requireClient, function(req, res) {
  var found = findOwnedDesign(req, res);
  if (!found) return;
  var body = readDesignBody(req, res);
  if (!body) return;
  try {
    var design = db.updateDesign(found.design.id, {
      name: body.name,
      orientation: req.body.payload.orientation,
      payload: body.payload,
      thumb: body.thumb
    });
    res.json({ success: true, design: design });
  } catch (e) {
    console.error('Design update failed:', e.message);
    res.status(500).json({ error: 'Could not save the design.' });
  }
});

app.delete('/api/designs/:id', auth.requireClient, function(req, res) {
  var found = findOwnedDesign(req, res);
  if (!found) return;
  db.deleteDesign(found.design.id);
  res.json({ success: true });
});

// ── Screen takeover ───────────────────────────────────────
// Uploads one file, points the screen at it full screen, and puts the normal
// playlist back when the timer runs out.

var MAX_TAKEOVER_HOURS = 24;

function takeoverView(t) {
  if (!t) return null;
  return {
    id: t.id, screen_id: t.screen_id, label: t.label,
    expires_at: t.expires_at, created_by_name: t.created_by_name, created_at: t.created_at
  };
}

app.get('/api/takeover/:screenId', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client) return res.status(401).json({ error: 'Not signed in.' });
  var t = db.getTakeoverForScreen(req.params.screenId);
  if (t && t.company_id !== client.company_id) t = null;
  res.json({ takeover: takeoverView(t) });
});

app.post('/api/takeover/:screenId', auth.requireClient, upload.single('file'), function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) return res.status(400).json({ error: 'No Yodeck token configured.' });
  if (!req.file) return res.status(400).json({ error: 'Choose a file to show.' });

  var expiresAt = new Date(req.body.expiresAt);
  if (isNaN(expiresAt.getTime())) return res.status(400).json({ error: 'Pick when the takeover should end.' });
  if (expiresAt.getTime() <= Date.now()) return res.status(400).json({ error: 'That end time has already passed.' });
  if (expiresAt.getTime() - Date.now() > MAX_TAKEOVER_HOURS * 3600 * 1000) {
    return res.status(400).json({ error: 'A takeover can run for at most ' + MAX_TAKEOVER_HOURS + ' hours.' });
  }

  var screenId = req.params.screenId;
  var label = (req.body.label || req.file.originalname || 'Takeover').slice(0, 120);
  var existing = db.getTakeoverForScreen(screenId);

  yodeck.startTakeover(client.yodeck_token, screenId, req.file.buffer, req.file.originalname,
                       req.file.mimetype, label, 30)
    .then(function(result) {
      // Replacing a takeover must keep the ORIGINAL playlist as the restore
      // target, or the screen would be handed back to the previous takeover.
      var restoreTo = existing ? existing.previous_content : result.previous;
      var row = db.createTakeover({
        company_id: client.company_id, screen_id: screenId,
        screen_name: req.body.screenName || '', label: label,
        media_id: result.mediaId, playlist_id: result.playlistId,
        previous_content: restoreTo, expires_at: expiresAt.toISOString(),
        user_id: client.id, user_name: client.username
      });
      res.json({ success: true, takeover: takeoverView(row) });
    })
    .catch(function(err) {
      console.error('Takeover failed:', err.response ? JSON.stringify(err.response.data) : err.message);
      res.status(500).json({ error: 'Could not start the takeover. The screen is unchanged.' });
    });
});

app.delete('/api/takeover/:screenId', auth.requireClient, function(req, res) {
  var client = db.getClient(req.session.clientId);
  if (!client || !client.yodeck_token) return res.status(400).json({ error: 'No Yodeck token configured.' });
  var t = db.getTakeoverForScreen(req.params.screenId);
  if (!t || t.company_id !== client.company_id) return res.status(404).json({ error: 'No takeover running on that screen.' });

  yodeck.endTakeover(client.yodeck_token, t.screen_id, t.previous_content, t.playlist_id)
    .then(function() {
      db.deleteTakeover(t.id);
      res.json({ success: true });
    })
    .catch(function(err) {
      console.error('Ending takeover failed:', err.message);
      res.status(500).json({ error: 'Could not restore the playlist. Try again, or push from the portal.' });
    });
});

// Sweeper. Runs on a timer and once at boot, so a takeover that expired while
// the server was restarting still gets cleared instead of staying up forever.
function sweepExpiredTakeovers() {
  var due = db.getExpiredTakeovers();
  if (!due.length) return;
  console.log('Takeover sweep: restoring', due.length, 'expired takeover(s)');
  due.forEach(function(t) {
    var company = db.getCompany(t.company_id);
    if (!company || !company.yodeck_token) {
      console.warn('Takeover', t.id, 'has no usable token; dropping the record');
      db.deleteTakeover(t.id);
      return;
    }
    yodeck.endTakeover(company.yodeck_token, t.screen_id, t.previous_content, t.playlist_id)
      .then(function() {
        db.deleteTakeover(t.id);
        console.log('Takeover', t.id, 'expired; screen', t.screen_id, 'restored');
      })
      .catch(function(err) {
        // Left in place deliberately so the next sweep tries again.
        console.error('Takeover', t.id, 'restore failed, will retry:', err.message);
      });
  });
}

setInterval(sweepExpiredTakeovers, 30 * 1000);

// ════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════════════════════════════

app.get('/admin/login', function(req, res) { sendHTML(res, 'admin-login.html'); });

app.post('/admin/login', function(req, res) {
  if (req.body.username === process.env.ADMIN_USERNAME && req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

app.get('/admin/logout', function(req, res) { req.session.destroy(); res.redirect('/admin/login'); });
app.get('/admin', auth.requireAdmin, function(req, res) { sendHTML(res, 'admin.html'); });

// ── Companies ─────────────────────────────────────────────
app.get('/admin/api/companies', auth.requireAdmin, function(req, res) {
  var companies = db.getAllCompanies();
  // Attach user count to each company
  var result = companies.map(function(c) {
    var users = db.getUsersByCompany(c.id);
    return Object.assign({}, c, { user_count: users.length });
  });
  res.json(result);
});

app.post('/admin/api/companies', auth.requireAdmin, function(req, res) {
  var data = req.body;
  if (!data.name) return res.status(400).json({ error: 'Company name is required.' });
  var result = db.createCompany({ name: data.name, yodeck_token: data.yodeck_token, assigned_screens: data.assigned_screens });
  res.json({ success: true, id: result.id });
});

app.put('/admin/api/companies/:id', auth.requireAdmin, function(req, res) {
  var data = req.body;
  db.updateCompany(req.params.id, { name: data.name, yodeck_token: data.yodeck_token, assigned_screens: data.assigned_screens, active: data.active });
  res.json({ success: true });
});

app.delete('/admin/api/companies/:id', auth.requireAdmin, function(req, res) {
  db.deleteCompany(req.params.id);
  res.json({ success: true });
});

// ── Users ──────────────────────────────────────────────────
app.get('/admin/api/companies/:companyId/users', auth.requireAdmin, function(req, res) {
  var users = db.getUsersByCompany(req.params.companyId).map(function(u) {
    return { id: u.id, company_id: u.company_id, name: u.name, email: u.email, username: u.username, active: u.active, created_at: u.created_at };
  });
  res.json(users);
});

app.post('/admin/api/companies/:companyId/users', auth.requireAdmin, function(req, res) {
  var data = req.body;
  if (!data.username || !data.password) return res.status(400).json({ error: 'Username and password are required.' });
  bcrypt.hash(data.password, 10, function(err, hashed) {
    var result = db.createUser({ company_id: req.params.companyId, name: data.name, email: data.email, username: data.username, password: hashed });
    if (result.error) return res.status(400).json({ error: result.error });
    mailer.sendWelcomeEmail({ clientName: data.name, clientEmail: data.email, username: data.username, password: data.password })
      .catch(function(e) { console.warn('Welcome email failed:', e.message); });
    res.json({ success: true, id: result.id });
  });
});

app.put('/admin/api/users/:id', auth.requireAdmin, function(req, res) {
  var data = req.body;
  if (data.password) {
    bcrypt.hash(data.password, 10, function(err, hashed) {
      db.updateUser(req.params.id, { name: data.name, email: data.email, username: data.username, password: hashed, active: data.active, must_change_password: true });
      res.json({ success: true });
    });
  } else {
    db.updateUser(req.params.id, { name: data.name, email: data.email, username: data.username, active: data.active, must_change_password: false });
    res.json({ success: true });
  }
});

app.delete('/admin/api/users/:id', auth.requireAdmin, function(req, res) {
  db.deleteUser(req.params.id);
  res.json({ success: true });
});

app.get('/admin/api/log', auth.requireAdmin, function(req, res) { res.json(db.getLog(100)); });

app.post('/admin/api/verify-token', auth.requireAdmin, function(req, res) {
  yodeck.verifyToken(req.body.token).then(function(result) { res.json(result); });
});

// ── Static files ──────────────────────────────────────────
// Public assets only (images, css, vendor scripts). App pages live in views/
// and are reachable only through the guarded routes above.
app.use(express.static(PUBLIC));

// ── 404 ───────────────────────────────────────────────────
app.use(function(req, res) {
  res.status(404).send('<html><body style="font-family:sans-serif;padding:40px;background:#0a0a0f;color:#f1f1f3"><h2>Page not found</h2><p><a href="/login" style="color:#6366f1">/login</a> &nbsp;|&nbsp; <a href="/admin/login" style="color:#6366f1">/admin/login</a></p></body></html>');
});

// ── Start ─────────────────────────────────────────────────
var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Signage Portal running on port ' + PORT);
  sweepExpiredTakeovers();
  console.log('Client login:  /login');
  console.log('Admin login:   /admin/login');
});
