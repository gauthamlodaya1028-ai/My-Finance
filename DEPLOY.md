# Deploying My Finance (Hostinger Cloud + Appwrite)

The app uses **Appwrite Cloud** for database (TablesDB) and login (Appwrite Auth), so there's
no DB to run on the host — Hostinger just runs the Node/Express server. There is **no chat**
feature; reporting is via the in-app **Export PDF** button. Behavior is env-driven — see
[.env.example](.env.example).

## 0. Prerequisites
- Appwrite project (already created): endpoint `https://sgp.cloud.appwrite.io/v1`, project `6a39264f0000485dfbc1`, database `finance`.
- Data already migrated into Appwrite (`appwrite-setup.js` + `migrate-to-appwrite.js` were run locally).
- Hostinger **Cloud** plan with the **"Node.js Web App"** option (no VPS/SSH needed).

## 1. Appwrite — allow your production domain
Console → **Integrations → Platforms → Add platform → Web app** → hostname = your domain
(e.g. `finance.gauramdigital.com`). Without this, browser login is CORS-blocked in production.
Keep the `localhost` platform too (for local dev).

## 2. Hostinger — deploy the Node.js app from GitHub
hPanel → **Websites → Add website → Node.js Web App → Deploy from GitHub**:
1. Connect repo `gauthamlodaya1028-ai/My-Finance`, branch `main`.
2. **Install command:** `npm install`   •   **Start command:** `npm start`   •   Node 18+.
3. **Environment variables** (hPanel → your Node app → Environment) — set:
   ```
   APPWRITE_ENDPOINT=https://sgp.cloud.appwrite.io/v1
   APPWRITE_PROJECT=6a39264f0000485dfbc1
   APPWRITE_API_KEY=<server api key>
   APPWRITE_DB=finance
   ALLOWED_EMAIL=youremail@example.com
   ```
   (Hostinger sets `PORT` automatically; the app reads `process.env.PORT`.)
   Do **not** commit `.env` — set these in the panel.
4. Deploy, then map your domain to the app (hPanel) and ensure HTTPS is on
   (**required** for Appwrite login).

## 3. Verify in production
- `GET /api/health` → `{ok:true}` (public).
- `GET /api/config` → `auth: "appwrite"`.
- Any `/api/*` data route without a token → `401`.
- Open the domain → **Sign in** → email code → your data loads (it's the same Appwrite project).
- **Export PDF** button (bottom-right) downloads the summary report.

## Notes
- **Stateless host**: all data lives in Appwrite Cloud, so Hostinger restarts/redeploys lose nothing.
- **No chat**: removed by design (couldn't run the CLI on Hostinger Cloud, and the goal was a
  no-cost setup). The app exports a PDF summary instead.
- **Backups**: Appwrite Cloud holds your data; `migrate-to-appwrite.js --wipe` can re-seed from a
  local `finance.db` if ever needed.
- **Other backends**: unset the `APPWRITE_*` vars and the same code falls back to Supabase
  Postgres (`DATABASE_URL`) or local SQLite.
