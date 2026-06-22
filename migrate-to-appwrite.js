// One-time: copy local finance.db (SQLite) rows into Appwrite TablesDB.
// Run AFTER appwrite-setup.js. Maps old integer debt ids -> new Appwrite ids.
//   node migrate-to-appwrite.js          (append)
//   node migrate-to-appwrite.js --wipe   (delete all Appwrite rows first)
import 'dotenv/config';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { repo, APPWRITE } from './appwrite.js';

if (!APPWRITE) { console.error('Appwrite env not set'); process.exit(1); }
const wipe = process.argv.includes('--wipe');
const __dirname = dirname(fileURLToPath(import.meta.url));
const sdb = new Database(join(__dirname, 'finance.db'), { readonly: true });
const rows = (t) => { try { return sdb.prepare(`SELECT * FROM ${t}`).all(); } catch { return []; } };
const strip = (r, keys) => Object.fromEntries(keys.map((k) => [k, r[k]]));

const ENTRY = ['kind', 'currency', 'recv_currency', 'category', 'narrative', 'amount', 'rate', 'date'];
const DEBT = ['source', 'direction', 'remaining', 'emi', 'remaining_months', 'currency', 'monthly_interest', 'interest_days', 'status', 'start_month', 'notes'];
const PAY = ['debt_id', 'amount', 'date', 'note'];
const RECUR = ['label', 'amount', 'currency', 'category', 'start_month', 'end_month'];

(async () => {
  if (wipe) {
    for (const t of ['payments', 'interest_payments', 'debts', 'entries', 'recurring']) {
      for (const r of await repo.list(t)) await repo.remove(t, r.id);
    }
    console.log('wiped Appwrite rows');
  }

  for (const e of rows('entries')) await repo.create('entries', strip(e, ENTRY));
  console.log('entries:', rows('entries').length);

  const idMap = {}; // old sqlite debt id -> new appwrite id
  for (const d of rows('debts')) { const created = await repo.create('debts', strip(d, DEBT)); idMap[d.id] = created.id; }
  console.log('debts:', rows('debts').length);

  for (const p of rows('payments')) await repo.create('payments', { ...strip(p, PAY), debt_id: String(idMap[p.debt_id] || '') });
  for (const p of rows('interest_payments')) await repo.create('interest_payments', { ...strip(p, PAY), debt_id: String(idMap[p.debt_id] || '') });
  console.log('payments:', rows('payments').length, 'interest:', rows('interest_payments').length);

  for (const r of rows('recurring')) await repo.create('recurring', strip(r, RECUR));
  console.log('recurring:', rows('recurring').length);

  console.log('migration done.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
