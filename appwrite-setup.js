// One-time: create the Appwrite database, tables, and columns for My Finance.
// Idempotent — re-running ignores "already exists" (409) errors.
//   node appwrite-setup.js
import 'dotenv/config';
import { Client, TablesDB } from 'node-appwrite';

const endpoint = process.env.APPWRITE_ENDPOINT;
const project = process.env.APPWRITE_PROJECT;
const apiKey = process.env.APPWRITE_API_KEY;
const DB_ID = process.env.APPWRITE_DB || 'finance';
if (!endpoint || !project || !apiKey) { console.error('Set APPWRITE_ENDPOINT, APPWRITE_PROJECT, APPWRITE_API_KEY in .env'); process.exit(1); }

const db = new TablesDB(new Client().setEndpoint(endpoint).setProject(project).setKey(apiKey));
const ok = async (p) => { try { return await p; } catch (e) { if (e.code === 409) return null; throw e; } };
const S = (t, k, size = 256) => ok(db.createStringColumn(DB_ID, t, k, size, false));
const F = (t, k) => ok(db.createFloatColumn(DB_ID, t, k, false));
const I = (t, k) => ok(db.createIntegerColumn(DB_ID, t, k, false));

// table -> column builders (run sequentially to avoid rate limits)
const SCHEMA = {
  entries: async () => { await S('entries', 'kind', 16); await S('entries', 'currency', 8); await S('entries', 'recv_currency', 8); await S('entries', 'category', 128); await S('entries', 'narrative', 1000); await F('entries', 'amount'); await F('entries', 'rate'); await S('entries', 'date', 16); },
  debts: async () => { await S('debts', 'source', 256); await S('debts', 'direction', 16); await F('debts', 'remaining'); await F('debts', 'emi'); await I('debts', 'remaining_months'); await S('debts', 'currency', 8); await F('debts', 'monthly_interest'); await S('debts', 'interest_days', 32); await S('debts', 'status', 16); await S('debts', 'start_month', 16); await S('debts', 'notes', 1000); },
  payments: async () => { await S('payments', 'debt_id', 64); await F('payments', 'amount'); await S('payments', 'date', 16); await S('payments', 'note', 500); },
  interest_payments: async () => { await S('interest_payments', 'debt_id', 64); await F('interest_payments', 'amount'); await S('interest_payments', 'date', 16); await S('interest_payments', 'note', 500); },
  recurring: async () => { await S('recurring', 'label', 256); await F('recurring', 'amount'); await S('recurring', 'currency', 8); await S('recurring', 'category', 128); await S('recurring', 'start_month', 16); await S('recurring', 'end_month', 16); },
};

async function waitReady(table) {
  for (let i = 0; i < 30; i++) {
    const cols = await db.listColumns(DB_ID, table);
    if (cols.columns.every((c) => c.status === 'available')) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn(`  (columns for ${table} still processing — they'll finish shortly)`);
}

(async () => {
  await ok(db.create(DB_ID, 'Finance'));
  console.log('database ok:', DB_ID);
  for (const [table, build] of Object.entries(SCHEMA)) {
    await ok(db.createTable(DB_ID, table, table));
    await build();
    await waitReady(table);
    console.log('table ready:', table);
  }
  console.log('Appwrite setup complete.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
