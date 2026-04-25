var low = require('lowdb');
var FileSync = require('lowdb/adapters/FileSync');
var path = require('path');

var DB_PATH = process.env.DB_PATH || path.join(__dirname, 'portal.json');
var adapter = new FileSync(DB_PATH);
var db = low(adapter);

db.defaults({
  clients: [],
  publish_log: [],
  _nextClientId: 1,
  _nextLogId: 1
}).write();

var dbHelper = {

  getClient: function(id) {
    return db.get('clients').find({ id: Number(id) }).value();
  },

  getClientByUsername: function(username) {
    return db.get('clients').find({ username: username, active: 1 }).value();
  },

  getAllClients: function() {
    return db.get('clients').orderBy(['created_at'], ['desc']).value();
  },

  createClient: function(data) {
    var id = db.get('_nextClientId').value();
    var client = {
      id: id,
      name: data.name,
      email: data.email,
      username: data.username,
      password: data.password,
      yodeck_token: data.yodeck_token || null,
      assigned_screens: JSON.stringify(data.assigned_screens || []),
      active: 1,
      created_at: new Date().toISOString()
    };
    db.get('clients').push(client).write();
    db.set('_nextClientId', id + 1).write();
    return { lastInsertRowid: id };
  },

  updateClient: function(id, data) {
    var updates = {
      name: data.name,
      email: data.email,
      username: data.username,
      yodeck_token: data.yodeck_token || null,
      assigned_screens: JSON.stringify(data.assigned_screens || []),
      active: data.active ? 1 : 0
    };
    if (data.password) updates.password = data.password;
    db.get('clients').find({ id: Number(id) }).assign(updates).write();
  },

  deleteClient: function(id) {
    db.get('clients').remove({ id: Number(id) }).write();
  },

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
