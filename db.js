import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, 'finance.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Income & expense ledger entries
  CREATE TABLE IF NOT EXISTS entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL CHECK (type IN ('income','expense')),
    category    TEXT NOT NULL DEFAULT 'General',
    narrative   TEXT NOT NULL DEFAULT '',
    amount      REAL NOT NULL,
    date        TEXT NOT NULL,           -- YYYY-MM-DD
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Debts: payable (I owe) and receivable (owed to me)
  CREATE TABLE IF NOT EXISTS debts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    direction     TEXT NOT NULL CHECK (direction IN ('payable','receivable')),
    counterparty  TEXT NOT NULL,
    principal     REAL NOT NULL,
    interest_rate REAL NOT NULL DEFAULT 0,   -- annual %, simple interest
    start_date    TEXT NOT NULL,
    due_date      TEXT,
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Payments made against a debt (reduces / settles it)
  CREATE TABLE IF NOT EXISTS payments (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    debt_id   INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    amount    REAL NOT NULL,
    date      TEXT NOT NULL,
    note      TEXT NOT NULL DEFAULT ''
  );
`);

export default db;
