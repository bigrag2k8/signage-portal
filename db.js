var low = require('lowdb');
var FileSync = require('lowdb/adapters/FileSync');
var path = require('path');
var fs = require('fs');

var DB_PATH = process.env.DB_PATH || path.join(__dirname, 'portal.json');
var adapter = new FileSync(DB_PATH);
var db = low(adapter);

// Saved designs keep only their metadata in lowdb. The canvas JSON carries
// embedded images and runs to megabytes, and lowdb rewrites this whole file on
// every write — so a publish-log entry would rewrite every design too. The
// heavy payload lives in its own file instead. Defaults next to the database so
// it lands on the same mounted volume in production.
var DESIGNS_DIR = process.env.DESIGNS_PATH || path.join(path.dirname(DB_PATH), 'designs');
try { fs.mkdirSync(DESIGNS_DIR, { recursive: true }); } catch (e) { console.warn('Could not create designs dir:', e.message); }
// Logged so it is obvious whether designs landed on a mounted volume or on the
// container filesystem, where a redeploy would wipe them.
console.log('Designs stored in:', DESIGNS_DIR);

function designFile(id) { return path.join(DESIGNS_DIR, String(Number(id)) + '.json'); }
function thumbFile(id) { return path.join(DESIGNS_DIR, String(Number(id)) + '.png'); }

db.defaults({
  companies: [],
  users: [],
  clients: [], // legacy - kept for backward compat
  publish_log: [],
  designs: [],
  takeovers: [],
  active_alerts: [],
  alert_log: [],
  _nextCompanyId: 1,
  _nextUserId: 1,
  _nextClientId: 1,
  _nextLogId: 1,
  _nextDesignId: 1,
  _nextTakeoverId: 1
}).write();

// ── Migrate existing clients to companies/users if needed ──
(function migrate() {
  var clients = db.get('clients').value();
  var companies = db.get('companies').value();
  if (clients.length > 0 && companies.length === 0) {
    console.log('Migrating', clients.length, 'existing clients to companies/users...');
    var nextCompanyId = 1;
    var nextUserId = 1;
    clients.forEach(function(client) {
      // Create a company from each client
      var company = {
        id: nextCompanyId,
        name: client.name,
        yodeck_token: client.yodeck_token || null,
        assigned_screens: client.assigned_screens || '[]',
        active: client.active !== undefined ? client.active : 1,
        created_at: client.created_at || new Date().toISOString()
      };
      db.get('companies').push(company).write();

      // Create a user for each client
      var user = {
        id: nextUserId,
        company_id: nextCompanyId,
        name: client.name,
        email: client.email || '',
        username: client.username,
        password: client.password,
        must_change_password: client.must_change_password || 0,
        active: client.active !== undefined ? client.active : 1,
        created_at: client.created_at || new Date().toISOString()
      };
      db.get('users').push(user).write();

      nextCompanyId++;
      nextUserId++;
    });
    db.set('_nextCompanyId', nextCompanyId).write();
    db.set('_nextUserId', nextUserId).write();
    console.log('Migration complete.');
  }
})();

var dbHelper = {

  // ── Companies ───────────────────────────────────────────

  getAllCompanies: function() {
    return db.get('companies').orderBy(['created_at'], ['desc']).value();
  },

  getCompany: function(id) {
    return db.get('companies').find({ id: Number(id) }).value();
  },

  createCompany: function(data) {
    var id = db.get('_nextCompanyId').value();
    var company = {
      id: id,
      name: data.name,
      yodeck_token: data.yodeck_token || null,
      assigned_screens: JSON.stringify(data.assigned_screens || []),
      active: 1,
      created_at: new Date().toISOString()
    };
    db.get('companies').push(company).write();
    db.set('_nextCompanyId', id + 1).write();
    return { id: id };
  },

  updateCompany: function(id, data) {
    var updates = {
      name: data.name,
      yodeck_token: data.yodeck_token || null,
      assigned_screens: JSON.stringify(data.assigned_screens || []),
      active: data.active ? 1 : 0
    };
    db.get('companies').find({ id: Number(id) }).assign(updates).write();
  },

  deleteCompany: function(id) {
    db.get('companies').remove({ id: Number(id) }).write();
    // Also delete all users in this company
    db.get('users').remove({ company_id: Number(id) }).write();
  },

  // ── Users ───────────────────────────────────────────────

  getUsersByCompany: function(companyId) {
    return db.get('users').filter({ company_id: Number(companyId) }).orderBy(['created_at'], ['asc']).value();
  },

  getUser: function(id) {
    return db.get('users').find({ id: Number(id) }).value();
  },

  getUserByUsername: function(username) {
    return db.get('users').find({ username: username, active: 1 }).value();
  },

  createUser: function(data) {
    var id = db.get('_nextUserId').value();
    // Check username unique
    var existing = db.get('users').find({ username: data.username }).value();
    if (existing) return { error: 'Username already exists.' };

    var user = {
      id: id,
      company_id: Number(data.company_id),
      name: data.name,
      email: data.email || '',
      username: data.username,
      password: data.password,
      must_change_password: 1,
      active: 1,
      created_at: new Date().toISOString()
    };
    db.get('users').push(user).write();
    db.set('_nextUserId', id + 1).write();
    return { id: id };
  },

  updateUser: function(id, data) {
    var updates = {
      name: data.name,
      email: data.email || '',
      username: data.username,
      active: data.active ? 1 : 0,
      must_change_password: data.must_change_password ? 1 : 0
    };
    if (data.password) updates.password = data.password;
    db.get('users').find({ id: Number(id) }).assign(updates).write();
  },

  deleteUser: function(id) {
    db.get('users').remove({ id: Number(id) }).write();
  },

  // ── Legacy client methods (used by portal routes) ───────
  // These now resolve through users + companies

  getClient: function(userId) {
    var user = db.get('users').find({ id: Number(userId) }).value();
    if (!user) return null;
    var company = db.get('companies').find({ id: Number(user.company_id) }).value();
    if (!company) return null;
    // Return a merged object that looks like the old client
    return {
      id: user.id,
      company_id: company.id,
      name: company.name,
      email: user.email,
      username: user.username,
      password: user.password,
      yodeck_token: company.yodeck_token,
      assigned_screens: company.assigned_screens,
      active: user.active,
      must_change_password: user.must_change_password
    };
  },

  getClientByUsername: function(username) {
    var user = db.get('users').find({ username: username, active: 1 }).value();
    if (!user) return null;
    var company = db.get('companies').find({ id: Number(user.company_id) }).value();
    if (!company) return null;
    return {
      id: user.id,
      company_id: company.id,
      name: company.name,
      email: user.email,
      username: user.username,
      password: user.password,
      yodeck_token: company.yodeck_token,
      assigned_screens: company.assigned_screens,
      active: user.active,
      must_change_password: user.must_change_password
    };
  },

  updateClientPassword: function(userId, hashedPassword, mustChange) {
    db.get('users').find({ id: Number(userId) }).assign({
      password: hashedPassword,
      must_change_password: mustChange ? 1 : 0
    }).write();
  },

  // ── Publish log ─────────────────────────────────────────

  logPublish: function(data) {
    var id = db.get('_nextLogId').value();
    db.get('publish_log').push({
      id: id,
      client_id: Number(data.client_id),
      client_name: data.client_name,
      filename: data.filename,
      screen_names: data.screen_names,
      published_at: new Date().toISOString(),
      status: 'success'
    }).write();
    db.set('_nextLogId', id + 1).write();
  },

  getLog: function(limit) {
    return db.get('publish_log').orderBy(['published_at'], ['desc']).take(limit || 100).value();
  },

  // ── Saved designs ───────────────────────────────────────
  // Metadata lives here; the canvas payload and thumbnail live in DESIGNS_DIR.

  getDesignsByCompany: function(companyId) {
    return db.get('designs').filter({ company_id: Number(companyId) }).orderBy(['updated_at'], ['desc']).value();
  },

  getDesign: function(id) {
    return db.get('designs').find({ id: Number(id) }).value();
  },

  // Returns the stored canvas payload, or null if the file is missing/corrupt.
  readDesignCanvas: function(id) {
    try {
      return JSON.parse(fs.readFileSync(designFile(id), 'utf8'));
    } catch (e) {
      console.warn('Could not read design', id, e.message);
      return null;
    }
  },

  readDesignThumb: function(id) {
    try {
      return fs.readFileSync(thumbFile(id));
    } catch (e) {
      return null;
    }
  },

  countDesignsForCompany: function(companyId) {
    return db.get('designs').filter({ company_id: Number(companyId) }).size().value();
  },

  createDesign: function(data) {
    var id = db.get('_nextDesignId').value();
    var now = new Date().toISOString();
    // Write the payload first — a metadata row pointing at a missing file would
    // show up in the list as a design that cannot be opened.
    fs.writeFileSync(designFile(id), JSON.stringify(data.payload));
    if (data.thumb) { try { fs.writeFileSync(thumbFile(id), data.thumb); } catch (e) { console.warn('Thumb write failed:', e.message); } }
    var design = {
      id: id,
      company_id: Number(data.company_id),
      created_by: Number(data.user_id),
      created_by_name: data.user_name || '',
      name: data.name,
      orientation: data.orientation || 'landscape',
      created_at: now,
      updated_at: now
    };
    db.get('designs').push(design).write();
    db.set('_nextDesignId', id + 1).write();
    return design;
  },

  updateDesign: function(id, data) {
    fs.writeFileSync(designFile(id), JSON.stringify(data.payload));
    if (data.thumb) { try { fs.writeFileSync(thumbFile(id), data.thumb); } catch (e) { console.warn('Thumb write failed:', e.message); } }
    var updates = { updated_at: new Date().toISOString() };
    if (data.name) updates.name = data.name;
    if (data.orientation) updates.orientation = data.orientation;
    db.get('designs').find({ id: Number(id) }).assign(updates).write();
    return db.get('designs').find({ id: Number(id) }).value();
  },

  deleteDesign: function(id) {
    db.get('designs').remove({ id: Number(id) }).write();
    [designFile(id), thumbFile(id)].forEach(function(f) {
      try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') console.warn('Could not remove', f, e.message); }
    });
  },

  // ── Takeovers ───────────────────────────────────────────
  // Persisted rather than held in memory: the promise is that the screen goes
  // back on its own, and an in-memory timer dies on every redeploy.

  getTakeoverForScreen: function(screenId) {
    return db.get('takeovers').find({ screen_id: String(screenId) }).value();
  },

  getTakeoversForCompany: function(companyId) {
    return db.get('takeovers').filter({ company_id: Number(companyId) }).value();
  },

  getAllTakeovers: function() {
    return db.get('takeovers').value();
  },

  // Anything already due, including while the server was down.
  getExpiredTakeovers: function(now) {
    var cutoff = now || Date.now();
    return db.get('takeovers').filter(function(t) {
      return new Date(t.expires_at).getTime() <= cutoff;
    }).value();
  },

  createTakeover: function(data) {
    var id = db.get('_nextTakeoverId').value();
    var row = {
      id: id,
      company_id: Number(data.company_id),
      screen_id: String(data.screen_id),
      screen_name: data.screen_name || '',
      label: data.label || '',
      media_id: data.media_id,
      playlist_id: data.playlist_id,
      previous_content: data.previous_content,
      expires_at: data.expires_at,
      created_by: Number(data.user_id),
      created_by_name: data.user_name || '',
      created_at: new Date().toISOString()
    };
    // One takeover per screen — a second replaces the first.
    db.get('takeovers').remove({ screen_id: String(data.screen_id) }).write();
    db.get('takeovers').push(row).write();
    db.set('_nextTakeoverId', id + 1).write();
    return row;
  },

  deleteTakeover: function(id) {
    db.get('takeovers').remove({ id: Number(id) }).write();
  },

  // ── Emergency alerts ────────────────────────────────────
  // The active record is portal bookkeeping (what our banner shows); the log
  // is the audit trail — who fired what, when, and how it ended. The log is
  // append-only on purpose.

  getActiveAlert: function(companyId) {
    return db.get('active_alerts').find({ company_id: Number(companyId) }).value();
  },

  setActiveAlert: function(data) {
    db.get('active_alerts').remove({ company_id: Number(data.company_id) }).write();
    var row = {
      company_id: Number(data.company_id),
      alert_id: data.alert_id,
      alert_name: data.alert_name,
      category: data.category || '',
      headline: data.headline,
      // From Yodeck's broadcast response: the instance handle for cancelling,
      // and when Yodeck itself will end the broadcast.
      broadcast_hash: data.broadcast_hash || null,
      ends_at: data.ends_at || null,
      fired_by: Number(data.user_id),
      fired_by_name: data.user_name || '',
      fired_at: new Date().toISOString()
    };
    db.get('active_alerts').push(row).write();
    return row;
  },

  // Alerts whose Yodeck-reported end_time has passed — the broadcast is over
  // on the screens, so the banner must not keep claiming it is live.
  getEndedActiveAlerts: function(now) {
    var cutoff = now || Date.now();
    return db.get('active_alerts').filter(function(a) {
      return a.ends_at && new Date(a.ends_at).getTime() <= cutoff;
    }).value();
  },

  clearActiveAlert: function(companyId) {
    db.get('active_alerts').remove({ company_id: Number(companyId) }).write();
  },

  logAlert: function(entry) {
    db.get('alert_log').push({
      company_id: Number(entry.company_id),
      action: entry.action, // 'broadcast' | 'cancelled' | 'marked-ended' | 'cancel-failed'
      alert_id: entry.alert_id,
      alert_name: entry.alert_name || '',
      headline: entry.headline || '',
      user_name: entry.user_name || '',
      detail: entry.detail || '',
      at: new Date().toISOString()
    }).write();
  },

  getAlertLog: function(limit) {
    return db.get('alert_log').orderBy(['at'], ['desc']).take(limit || 100).value();
  }

};

module.exports = dbHelper;
