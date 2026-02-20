# dante-web-render

Standalone web chat UI + API for DANTE, deployable on Render.

## What this is
- Express server serving a single-file UI at `/`.
- API endpoints:
  - `GET /api/threads?anonUserId=...`
  - `POST /api/threads` { anonUserId, title }
  - `GET /api/history?anonUserId=...&threadId=...`
  - `POST /api/chat` { anonUserId, threadId, text }
- Postgres persistence (Render Postgres): threads + messages keyed by an anonymous per-device id.
- Bot calls are proxied to your Mac relay over Tailscale.

## Environment variables (Render)
Required (all modes):
- `DANTE_BOT_URL` (e.g. `http://100.102.7.53:8787/chat`)
- `DANTE_SHARED_SECRET` (must match the Mac relay)
- `TAILSCALE_AUTHKEY` (create in Tailscale admin console; recommended: ephemeral key)

Persistence mode:
- Default: Postgres (recommended on Render)
  - `DATABASE_URL` (Render provides this when you attach a Postgres instance)
- SQLite (optional)
  - `DANTE_DB=sqlite`
  - `DANTE_SQLITE_PATH=/var/data/dante.sqlite` (recommended)
  - You must attach a **Render Persistent Disk** mounted at `/var/data` (otherwise the DB is ephemeral and resets on deploy/restart).

Optional:
- `TAILSCALE_HOSTNAME` (default: `dante-render`)
- `PGSSL=disable` if you are connecting to a local Postgres without SSL.

## Render start command
Set the service start command to:
```bash
bash ./start.sh
```

## Notes on Tailscale on Render
This repo starts Tailscale in userspace mode inside the Render service so it can reach your Mac relay over the tailnet without exposing the relay publicly.

## Run locally
### Postgres
```bash
npm i
export DATABASE_URL='postgres://...'
export DANTE_BOT_URL='http://127.0.0.1:8787/chat'
export DANTE_SHARED_SECRET='...'
node server.js
```

### SQLite
```bash
npm i
export DANTE_DB=sqlite
export DANTE_SQLITE_PATH=./dante.sqlite
export DANTE_BOT_URL='http://127.0.0.1:8787/chat'
export DANTE_SHARED_SECRET='...'
node server.js
```

Open: http://localhost:3000

## Notes
- No authentication. Device identity is stored in the browser's localStorage (`dante_anon_user_id`).
- Without auth, users can lose history if they clear site data or use a different browser/device.
