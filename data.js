// Unified repository over whichever backend is configured:
//   Appwrite (APPWRITE_*) → Postgres (DATABASE_URL) → SQLite (default).
// Handlers use list/get/create/update/remove and do sorting/filtering in JS.
import { PG, q, init as sqlInit } from './db.js';
import { APPWRITE, repo as awRepo } from './appwrite.js';

export const BACKEND = APPWRITE ? 'appwrite' : (PG ? 'postgres' : 'sqlite');

const sqlRepo = {
  list: (t) => q(`SELECT * FROM ${t}`),
  get: async (t, id) => (await q(`SELECT * FROM ${t} WHERE id = $1`, [id]))[0] || null,
  async create(t, data) {
    const keys = Object.keys(data);
    const cols = keys.join(',');
    const ph = keys.map((_, i) => `$${i + 1}`).join(',');
    return (await q(`INSERT INTO ${t} (${cols}) VALUES (${ph}) RETURNING *`, keys.map((k) => data[k])))[0];
  },
  async update(t, id, data) {
    const keys = Object.keys(data);
    if (!keys.length) return (await q(`SELECT * FROM ${t} WHERE id = $1`, [id]))[0];
    const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const vals = keys.map((k) => data[k]);
    vals.push(id);
    return (await q(`UPDATE ${t} SET ${set} WHERE id = $${vals.length} RETURNING *`, vals))[0];
  },
  remove: (t, id) => q(`DELETE FROM ${t} WHERE id = $1`, [id]),
};

export const data = APPWRITE ? awRepo : sqlRepo;

// Create SQL schema when on a SQL backend; no-op for Appwrite (setup script does it).
export async function initData() { if (!APPWRITE) await sqlInit(); }
