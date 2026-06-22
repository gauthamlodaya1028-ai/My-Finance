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

## Deploy on a VPS over SSH (the chosen path — CLI chat already on the host)

You have SSH and a logged-in `claude` CLI on the host. Steps (run on the VPS):

```bash
# 1. Get the code
cd ~ && git clone https://github.com/gauthamlodaya1028-ai/My-Finance.git
cd My-Finance && npm install

# 2. Find the CLI + its logged-in config dir (the 30-day login)
which claude                 # → CLAUDE_BIN  (e.g. /root/.nvm/.../bin/claude)
echo "$CLAUDE_CONFIG_DIR"    # if set; else the default is ~/.claude  (or ~/.config/claude)
echo "test" | claude -p      # confirm it answers (which account/subscription)

# 3. Create .env  (production values)
cat > .env <<'EOF'
DATABASE_URL=postgresql://postgres.<ref>:<pwd>@aws-0-<region>.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=<anon key>
ALLOWED_EMAIL=you@example.com
CLAUDE_BIN=/abs/path/to/claude          # from `which claude`
CLAUDE_CONFIG_DIR=/root/.claude         # dir logged into the subscription account
PORT=3000
EOF

# 4. Run it persistently with pm2 (survives reboots/crashes)
npm install -g pm2
pm2 start server.js --name my-finance
pm2 save && pm2 startup        # follow the printed command to enable on boot
pm2 logs my-finance            # should show [db=postgres, auth=true, chat=cli]
```

Then put a domain in front (Nginx reverse proxy → `localhost:3000`):

```nginx
server {
  server_name your-domain.com;
  location / { proxy_pass http://localhost:3000; proxy_set_header Host $host; }
}
```
`sudo certbot --nginx -d your-domain.com` for HTTPS. Magic-link auth **requires HTTPS** +
the Supabase Site URL/redirect set to `https://your-domain.com` (see step 3 below).

To update later: `cd ~/My-Finance && git pull && npm install && pm2 restart my-finance`.

---

## Chat via a subscription (no API key) — "log in once, stays logged in"
This is the OAuth-based, sanctioned version of a "browser login that persists" — the
`claude` CLI stores a refresh token at first login and renews it forever. Do NOT try to
automate/scrape claude.ai in a browser/Electron — it violates Anthropic's terms, is brittle,
and risks the account.

```bash
# 1. ON YOUR LAPTOP — one-time browser login into a dedicated config dir
CLAUDE_CONFIG_DIR="$HOME/.claude-finance" claude        # then /login with the chosen account

# 2. Carry that dir (it holds the refresh token) to the host
scp -r "$HOME/.claude-finance" user@host:~/.claude-finance

# 3. ON THE HOST — set in the app env (.env):
#    CLAUDE_CONFIG_DIR=/home/user/.claude-finance
#    CLAUDE_BIN=/abs/path/to/claude   (if not on PATH)
```
Leave `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` empty so chat uses this CLI. The app
spawns `claude -p` with that config dir; the CLI auto-refreshes the token, so it stays logged
in with no re-auth.

## Notes
- **Cost**: chat bills per use. Default model `claude-opus-4-8` (~$5/$25 per Mtok);
  set `CHAT_MODEL=claude-sonnet-4-6` or `claude-haiku-4-5` to cut cost.
- **Backups**: Supabase handles DB backups; your old `finance.db` is a local snapshot.
- Supabase is only the database + auth — Hostinger runs the Node server.
