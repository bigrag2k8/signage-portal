const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'portal.json');
const adapter = new FileSync(DB_PATH);
const db = low(adapter);

db.defaults({
  clients: [],
  publish_log: [],
  _nextClientId: 1,
  _nextLogId: 1
}).write();

const dbHelper = {
  getClient(id) {
    return db.get('clients').find({ id: Number(id) }).value();
  },
  getClientByUsername(username) {
    return db.get('clients').find({ username, active: 1 }).value();
  },
  getAllClients() {
    return db.get('clients').orderBy(['created_at'], ['desc']).value();
  },
  createClient({ name, email, username, password, yodeck_token, assigned_screens }) {
    const id = db.get('_nextClientId').value();
    const client = {
      id, name, email, username, password,
      yodeck_token: yodeck_token || null,
      assigned_screens: JSON.stringify(assigned_screens || []),
      active: 1,
      created_at: new Date().toISOString()
    };
    db.get('clients').push(client).write();
    db.set('_nextClientId', id + 1).write();
    return { lastInsertRowid: id };
  },
  updateClient(id, { name, email, username, password, yodeck_token, assigned_screens, active }) {
    const updates = {
      name, email, username,
      yodeck_token: yodeck_token || null,
      assigned_screens: JSON.stringify(assigned_screens || []),
      active: active ? 1 : 0
    };
    if (password) updates.password = password;
    db.get('clients').find({ id: Number(id) }).assign(updates).write();
  },
  deleteClient(id) {
    db.get('clients').remove({ id: Number(id) }).write();
  },
  logPublish({ client_id, client_name, filename, screen_names }) {
    const id = db.get('_nextLogId').value();
    db.get('publish_log').push({
      id, client_id: Number(client_id), client_name,
      filename, screen_names,
      published_at: new Date().toISOString(),
      status: 'success'
    }).write();
    db.set('_nextLogId', id + 1).write();
  },
  getLog(limit = 100) {
    return db.get('publish_log').orderBy(['published_at'], ['desc']).take(limit).value();
  }
};

module.exports = dbHelper;
