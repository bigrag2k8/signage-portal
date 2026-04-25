// db.js — SQLite database setup
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'portal.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    yodeck_token TEXT,
    assigned_screens TEXT DEFAULT '[]',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS publish_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    client_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    screen_names TEXT NOT NULL,
    published_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'success',
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );
`);

module.exports = db;
