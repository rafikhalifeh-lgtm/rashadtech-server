# AGENTS.md

## Cursor Cloud specific instructions

### Product overview

RashadTech TV is a streaming/gaming subscription reseller storefront (`index.html`) backed by a Node.js/Express API (`server.js`). Data is stored in JSONBin.io (external SaaS). Production: frontend on Netlify, API on Render.

### Services

| Service | Command | Port | Notes |
|---|---|---|---|
| API server | `npm start` | 3000 | Requires env vars for DB/Telegram features |
| Frontend (static) | `npx serve -l 8888 .` | 8888 | Serves `index.html`; API URL is hardcoded in the HTML |

Run each service in its own tmux session (see cloud agent tmux conventions).

### Required environment variables (API)

The server logs an error at startup if these are missing:

- `JB_KEY`, `JB_BIN` — JSONBin.io credentials (required for `/db/read`, `/db/write`, auth, purchases)
- `TG_TOKEN`, `TG_ADMIN` — Telegram bot notifications
- `API_SECRET` — secures `/set-code`
- `ADMIN_PASSWORD`, `ADMIN_PIN` — admin login (defaults exist in code but production overrides them)
- `PORT` — optional, defaults to 3000
- `RENDER_EXTERNAL_URL` — only needed on Render for Telegram webhook registration

Without `JB_KEY`/`JB_BIN`, health endpoints (`/`, `/ping`) work but all data/auth endpoints fail.

### Local development caveats

1. **CORS**: `server.js` only allows `rashadtech.tv`, `www.rashadtech.tv`, `*.netlify.app`. Browser requests from `http://localhost:8888` to the production API are blocked. For local frontend + API testing, add your local origin to `ALLOWED_ORIGINS` and point `RT_SERVER` in `index.html` to `http://localhost:3000`.
2. **No tests or lint**: `package.json` has only a `start` script. There is no ESLint, test runner, or Makefile.
3. **No docker-compose or devcontainer**: Setup is `npm install` only.
4. **Deployed demo**: https://rashadtechtv.netlify.app against https://rashadtech-server.onrender.com works without local CORS changes.

### Quick verification

```bash
# API health (works without env vars)
curl -s http://localhost:3000/ping

# Frontend serving
curl -sL -o /dev/null -w "%{http_code}" http://localhost:8888/
```

### Key files

- `server.js` — Express API (~900 lines)
- `index.html` — Frontend SPA (production entry point)
- `package.json` — Dependencies and `start` script
