// One-time data move: copy all rows from local finance.db (SQLite) into the
// Supabase Postgres database named by DATABASE_URL.
//
//   DATABASE_URL="postgresql://...pooler.supabase.com:6543/postgres" node migrate-to-postgres.js
//
// Safe to read: it only INSERTs into Postgres; it never writes to SQLite.
// Re-running appends duplicates — run once against an empty Postgres, or pass
// --truncate to clear the Postgres tables first.
import 'dotenv/config';
import Database from 'better-sqlite3';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const truncate = process.argv.includes('--truncate');

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdb = new Database(join(__dirname, 'finance.db'), { readonly: true });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Insert preserving original ids so foreign keys (debt_id) stay valid.
const TABLES = ['entries', 'debts', 'payments', 'interest_payments', 'recurring'];

async function copy(table) {
  const rows = sdb.prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) { console.log(`${table}: 0 rows`); return; }
  const cols = Object.keys(rows[0]);
  for (const r of rows) {
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    await pool.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`, cols.map((c) => r[c]));
  }
  console.log(`${table}: ${rows.length} rows copied`);
}

// After inserting explicit ids, bump each IDENTITY sequence past the max id.
async function fixSeq(table) {
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
  );
}

(async () => {
  // Ensure schema exists in Postgres first.
  await import('./db.js').then((m) => m.init());
  if (truncate) {
    for (const t of [...TABLES].reverse()) await pool.query(`TRUNCATE ${t} RESTART IDENTITY CASCADE`);
    console.log('truncated all tables');
  }
  for (const t of TABLES) await copy(t);
  for (const t of TABLES) await fixSeq(t);
  console.log('done.');
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
