// Dual-mode data layer:
//   • Local dev  → SQLite (finance.db), no DATABASE_URL needed.
//   • Production → Supabase Postgres when DATABASE_URL is set.
// One async query surface (q / one) using $1,$2 placeholders for both drivers.
import Database from 'better-sqlite3';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export const PG = !!process.env.DATABASE_URL;
// When Appwrite is the backend, don't open SQLite at all (avoids file locks).
const APPWRITE = !!(process.env.APPWRITE_ENDPOINT && process.env.APPWRITE_PROJECT && process.env.APPWRITE_API_KEY);
let pool, sdb;

if (APPWRITE) {
  // no-op: data.js routes everything to Appwrite
} else if (PG) {
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Supabase requires SSL
  });
} else {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  sdb = new Database(join(__dirname, 'finance.db'));
  sdb.pragma('journal_mode = WAL');
  sdb.pragma('foreign_keys = ON');
}

// Run a query. Returns rows for SELECT / RETURNING, [] otherwise.
export async function q(text, params = []) {
  if (PG) return (await pool.query(text, params)).rows;
  const sql = text.replace(/\$(\d+)/g, '?'); // positional, no reused placeholders
  const stmt = sdb.prepare(sql);
  if (/returning|^\s*select|^\s*with|^\s*pragma/i.test(text)) return stmt.all(...params);
  stmt.run(...params);
  return [];
}
export const one = async (text, params) => (await q(text, params))[0];

// --- schema (portable across both drivers) ---
const ID = PG ? 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const NOW = PG ? 'now()' : "datetime('now')";

export async function init() {
  await q(`CREATE TABLE IF NOT EXISTS entries (
    id ${ID},
    kind TEXT NOT NULL DEFAULT 'income' CHECK (kind IN ('income','expense','transfer')),
    currency TEXT NOT NULL DEFAULT 'INR',
    recv_currency TEXT NOT NULL DEFAULT 'INR',
    category TEXT NOT NULL DEFAULT 'General',
    narrative TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL,
    rate REAL NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (${NOW})
  )`);

  await q(`CREATE TABLE IF NOT EXISTS debts (
    id ${ID},
    source TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'payable' CHECK (direction IN ('payable','receivable')),
    remaining REAL NOT NULL,
    emi REAL DEFAULT 0,
    remaining_months INTEGER DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'INR',
    monthly_interest REAL NOT NULL DEFAULT 0,
    interest_days TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'paying' CHECK (status IN ('paying','not_decided','not_possible','closed')),
    start_month TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (${NOW})
  )`);

  await q(`CREATE TABLE IF NOT EXISTS payments (
    id ${ID},
    debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  )`);

  await q(`CREATE TABLE IF NOT EXISTS interest_payments (
    id ${ID},
    debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  )`);

  await q(`CREATE TABLE IF NOT EXISTS recurring (
    id ${ID},
    label TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    category TEXT NOT NULL DEFAULT 'General',
    start_month TEXT NOT NULL,
    end_month TEXT,
    created_at TEXT NOT NULL DEFAULT (${NOW})
  )`);

  // SQLite-only migrations for pre-existing finance.db files (Postgres starts fresh).
  if (!PG) {
    const ecols = sdb.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
    if (ecols.length && !ecols.includes('recv_currency')) {
      sdb.exec("ALTER TABLE entries ADD COLUMN recv_currency TEXT NOT NULL DEFAULT 'INR'");
      sdb.exec('UPDATE entries SET recv_currency = currency');
    }
    const dcols = sdb.prepare('PRAGMA table_info(debts)').all().map((c) => c.name);
    if (dcols.length && !dcols.includes('interest_days')) {
      sdb.exec("ALTER TABLE debts ADD COLUMN interest_days TEXT NOT NULL DEFAULT ''");
    }
  }
}
