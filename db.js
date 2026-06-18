import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, 'finance.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Multi-currency ledger: income, expense, and AED->INR transfers.
  --   kind     : income | expense | transfer
  --   currency : currency of amount (income/expense). For a transfer it is the
  --              SOURCE currency (AED) and INR received = amount * rate.
  --   rate     : INR per 1 AED (optional for income/expense, applied for transfer)
  CREATE TABLE IF NOT EXISTS entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL DEFAULT 'income' CHECK (kind IN ('income','expense','transfer')),
    currency    TEXT NOT NULL DEFAULT 'INR',
    category    TEXT NOT NULL DEFAULT 'General',
    narrative   TEXT NOT NULL DEFAULT '',
    amount      REAL NOT NULL,
    rate        REAL NOT NULL DEFAULT 0,  -- INR per AED
    date        TEXT NOT NULL,            -- YYYY-MM-DD
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

// --- migrate an older entries table (type/no currency) to the new schema ---
const cols = db.prepare("PRAGMA table_info(entries)").all().map((c) => c.name);
if (cols.includes('type') && !cols.includes('kind')) {
  db.exec(`
    ALTER TABLE entries RENAME TO entries_old;
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'income' CHECK (kind IN ('income','expense','transfer')),
      currency TEXT NOT NULL DEFAULT 'INR',
      category TEXT NOT NULL DEFAULT 'General',
      narrative TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL,
      rate REAL NOT NULL DEFAULT 0,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO entries (id, kind, currency, category, narrative, amount, rate, date, created_at)
      SELECT id, type, 'INR', category, narrative, amount, 0, date, created_at FROM entries_old;
    DROP TABLE entries_old;
  `);
}

export default db;
