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

  -- Debts: EMI-based and informal. 'remaining' is the live outstanding balance.
  CREATE TABLE IF NOT EXISTS debts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source           TEXT NOT NULL,                 -- lender / counterparty
    direction        TEXT NOT NULL DEFAULT 'payable' CHECK (direction IN ('payable','receivable')),
    remaining        REAL NOT NULL,                 -- current outstanding
    emi              REAL DEFAULT 0,                -- equated monthly installment
    remaining_months INTEGER DEFAULT 0,            -- months left in the plan
    currency         TEXT NOT NULL DEFAULT 'INR',   -- INR | AED
    monthly_interest REAL NOT NULL DEFAULT 0,       -- interest bleeding per month (e.g. Nizam)
    status           TEXT NOT NULL DEFAULT 'paying'
                     CHECK (status IN ('paying','not_decided','not_possible','closed')),
    start_month      TEXT,                          -- YYYY-MM the schedule starts
    notes            TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Payments made against a debt (reduces 'remaining')
  CREATE TABLE IF NOT EXISTS payments (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    debt_id   INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    amount    REAL NOT NULL,
    date      TEXT NOT NULL,
    note      TEXT NOT NULL DEFAULT ''
  );
`);

export default db;
