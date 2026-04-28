var low = require('lowdb');
var FileSync = require('lowdb/adapters/FileSync');
var path = require('path');

var DB_PATH = process.env.DB_PATH || path.join(__dirname, 'portal.json');
var adapter = new FileSync(DB_PATH);
var db = low(adapter);

db.defaults({
  companies: [],
  users: [],
  clients: [], // legacy - kept for backward compat
  publish_log: [],
  _nextCompanyId: 1,
  _nextUserId: 1,
  _nextClientId: 1,
  _nextLogId: 1
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
  }

};

module.exports = dbHelper;
