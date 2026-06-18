# Deploying My Finance (Hostinger Node.js + Supabase)

The app is **deploy-ready**: SQLite + no-auth locally, Supabase Postgres + auth in production,
chat via the Anthropic API (or the local `claude` CLI when no key is set). All behavior is
switched by environment variables — see [.env.example](.env.example).

## 0. Prerequisites
- Supabase project (Postgres + Auth).
- Anthropic API key (for chat in production).
- Hostinger "Node.js Web App" (deploy from GitHub).

## 1. Supabase — database
1. Dashboard → **Project Settings → Database → Connection string → Transaction pooler**
   (Supavisor, port **6543**, IPv4). Copy that URI → this is `DATABASE_URL`.
   (The direct 5432 string is IPv6-only and often unreachable from shared hosts — use the pooler.)
2. The app auto-creates its tables on first boot (`init()` in [db.js](db.js)).

## 2. Migrate your existing data (one time)
Your real data lives in the local `finance.db` (gitignored). Move it into Supabase:
```bash
DATABASE_URL="postgresql://...pooler.supabase.com:6543/postgres" node migrate-to-postgres.js
```
This creates the schema in Postgres and copies all rows (entries, debts, payments,
interest, recurring), preserving ids. Run it **once** (use `--truncate` to redo cleanly).
Alternatively, skip this and re-import the debt CSV in-app, then re-apply the two manual
fixes (Hitesh EMI=1000; Nizam `interest_days=20,30`).

## 3. Supabase — auth
1. **Authentication → Providers → Email**: enable. For real use, configure **SMTP**
   (Settings → Auth → SMTP) — the built-in mailer is heavily rate-limited.
2. **Authentication → URL Configuration**: set **Site URL** to your Hostinger domain
   (e.g. `https://yourdomain.com`) and add it to **Redirect URLs**. Magic links bounce otherwise.
3. Settings → API: copy **Project URL** (`SUPABASE_URL`) and **anon public key** (`SUPABASE_ANON_KEY`).
4. Set `ALLOWED_EMAIL` to your own email so only you can use the app.

## 4. Hostinger — deploy
1. hPanel → Websites → **Add website → Node.js Web App → Deploy from GitHub**.
   Connect the `gauthamlodaya1028-ai/My-Finance` repo, branch `main`.
2. **Build/Run**: install command `npm install`, start command `npm start`
   (the app reads `process.env.PORT` automatically).
3. **Environment variables** (hPanel Node.js app → Environment): set
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ALLOWED_EMAIL`,
   `ANTHROPIC_API_KEY`, and optionally `CHAT_MODEL`. Do **not** commit `.env`.
4. Deploy. Visit the domain → you should get the **Sign in** screen → magic link → the app,
   now reading/writing Supabase.

## 5. Verify in production
- `GET /api/health` → `{ok:true}` (public).
- `GET /api/config` → `authEnabled:true`.
- Any `/api/*` data route without a token → `401` (auth is enforced).
- Sign in with `ALLOWED_EMAIL`, confirm your debts/entries load (data migrated).
- Open chat → ask a question → confirm a reply (Anthropic API).

## Notes
- **Cost**: chat bills per use. Default model `claude-opus-4-8` (~$5/$25 per Mtok);
  set `CHAT_MODEL=claude-sonnet-4-6` or `claude-haiku-4-5` to cut cost.
- **Backups**: Supabase handles DB backups; your old `finance.db` is a local snapshot.
- Supabase is only the database + auth — Hostinger runs the Node server.
