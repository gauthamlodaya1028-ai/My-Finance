// Appwrite data layer (TablesDB) + auth verification.
// The SERVER does all DB work with the API key; the browser only logs in via
// Appwrite Auth and sends a JWT that verifyJwt() checks.
import { Client, TablesDB, Account, ID, Query } from 'node-appwrite';

const endpoint = process.env.APPWRITE_ENDPOINT;
const project = process.env.APPWRITE_PROJECT;
const apiKey = process.env.APPWRITE_API_KEY;

export const APPWRITE = !!(endpoint && project && apiKey);
export const DB_ID = process.env.APPWRITE_DB || 'finance';

let tablesDB = null;
if (APPWRITE) {
  const client = new Client().setEndpoint(endpoint).setProject(project).setKey(apiKey);
  tablesDB = new TablesDB(client);
}

// Strip Appwrite system fields; expose $id as `id`, $createdAt as `created_at`.
// Appwrite rejects null/undefined on optional columns — omit those keys.
function clean(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}
function mapRow(r) {
  const { $id, $createdAt, $updatedAt, $permissions, $databaseId, $tableId, $collectionId, $sequence, ...rest } = r;
  return { id: $id, created_at: $createdAt, ...rest };
}

export const repo = {
  // List all rows in a table (paginated; datasets are small).
  async list(table) {
    const out = [];
    let cursor;
    for (;;) {
      const queries = [Query.limit(100)];
      if (cursor) queries.push(Query.cursorAfter(cursor));
      const res = await tablesDB.listRows(DB_ID, table, queries);
      out.push(...res.rows.map(mapRow));
      if (res.rows.length < 100) break;
      cursor = res.rows[res.rows.length - 1].$id;
    }
    return out;
  },
  async get(table, id) {
    try { return mapRow(await tablesDB.getRow(DB_ID, table, id)); }
    catch { return null; }
  },
  async create(table, data) {
    return mapRow(await tablesDB.createRow(DB_ID, table, ID.unique(), clean(data)));
  },
  async update(table, id, data) {
    return mapRow(await tablesDB.updateRow(DB_ID, table, id, clean(data)));
  },
  async remove(table, id) {
    await tablesDB.deleteRow(DB_ID, table, id);
  },
};

// Verify an Appwrite session JWT (created client-side via account.createJWT()).
// Returns the account object (throws if the JWT is invalid/expired).
export async function verifyJwt(jwt) {
  const client = new Client().setEndpoint(endpoint).setProject(project).setJWT(jwt);
  return new Account(client).get();
}
