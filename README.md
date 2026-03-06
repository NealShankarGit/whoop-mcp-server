# WHOOP MCP Server

A Model Context Protocol (MCP) server that connects your WHOOP health data to Claude. Pulls recovery, sleep, strain, nap, and workout data via custom connector — 8 tools, 30+ biometric fields, remote HTTP deployment.

Designed to be hosted remotely and used as a custom connector in Claude.ai on any device (desktop, mobile, web).

Built using the [WHOOP Developer API v2](https://developer.whoop.com/docs/introduction).

> Forked from [yuridivonis/whoop-mcp-server](https://github.com/yuridivonis/whoop-mcp-server). Original server provided base MCP architecture and WHOOP API client. Extended by [Neal Shankar](https://nealshankar.com) with expanded biometric fields, new tools, bug fixes, and production deployment hardening.

## What's New in This Fork

- **8 MCP tools** (up from 6) — added `get_nap_data` and `get_workout_details`
- **30+ biometric fields** surfaced across all tools (up from ~12)
- **Extended `get_today`** with sleep consistency, sleep needed, sleep debt, restorative sleep, stage percentages + durations, wake events, full nap section with time windows, and weight
- **Extended `get_sleep_analysis`** with 11 new columns per night including respiratory rate, stage breakdowns, and sleep debt
- **Extended `get_strain_history`** with avg/max HR per day and detailed workout breakdown with sport, duration, strain, HR, calories, and distance
- **Session persistence** — extended session TTL to 24 hours with automatic expired session recovery; server auto-creates new sessions when stale session IDs are received, eliminating connector drops between chats
- **Fixed Express middleware conflict** — `express.json()` was consuming the request body before `StreamableHTTPServerTransport` could read it, causing "Parse error: Invalid JSON" on all MCP requests
- **Upgraded MCP SDK** from `^1.0.0` to `1.27.1` for working Streamable HTTP support
- **Database schema migrations** — automatically adds new columns to existing SQLite databases without data loss
- **Production deployment hardening** — systemd service config, Nginx reverse proxy setup, Cloudflare DNS/SSL integration

## Features

- **Recovery Data**: Recovery scores, HRV, resting heart rate, SpO2, skin temperature
- **Sleep Analysis**: Duration, stages (with percentages + durations), efficiency, performance, consistency, sleep needed, sleep debt, respiratory rate, wake events
- **Nap Tracking**: Nap detection, time windows, stage breakdowns, efficiency, wake events per hour, sleep need reduction
- **Strain Tracking**: Daily strain scores, calories burned, avg/max heart rate
- **Workout History**: Sport name, duration, strain, heart rate, calories, distance, altitude, HR zone durations
- **Body Measurements**: Weight (lbs), height, max heart rate
- **Auto-Sync**: Smart sync logic keeps data fresh without redundant API calls
- **90-Day History**: Local SQLite cache for trend analysis
- **Encrypted Token Storage**: OAuth tokens encrypted at rest using AES-256-GCM
- **Session Persistence**: 24-hour session TTL with automatic recovery for expired sessions

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_today` | Full daily briefing: recovery, sleep (with stages, consistency, debt, wake events), nap data, strain, weight |
| `get_recovery_trends` | Recovery patterns over time with HRV and RHR |
| `get_sleep_analysis` | Detailed sleep trends: duration, performance, efficiency, consistency, debt, all 4 stage %, wake events, respiratory rate |
| `get_strain_history` | Daily strain with avg/max HR + detailed workout breakdown (sport, duration, strain, HR, calories, distance) |
| `get_nap_data` | Nap history with time windows, stage breakdowns, efficiency, wake events per hour |
| `get_workout_details` | Detailed workout history with sport name, HR zones, distance, altitude |
| `sync_data` | Manually trigger a data sync (smart or full 90-day) |
| `get_auth_url` | Get WHOOP OAuth authorization URL |

## Fields Returned by `get_today`

### Sleep Stats
Recovery %, HRV, RHR, SpO2, Skin Temp, Sleep Performance %, Hours of Sleep, Sleep Needed, Sleep Debt, Sleep Efficiency %, Sleep Consistency %, Restorative Sleep (Deep + REM), Awake % + duration, Light % + duration, Deep (SWS) % + duration, REM % + duration, Wake Events, Respiratory Rate

### Nap Stats (when nap detected)
Time Window, Duration, Hours of Sleep, Restorative Sleep, Sleep Need Reduced, Efficiency %, Awake/Light/Deep/REM % + durations, Wake Events per hour

### Strain Stats
Day Strain, Calories, Avg HR, Max HR

### Body
Weight (lbs)

## Setup

### 1. Create a WHOOP Developer App

1. Go to [developer.whoop.com](https://developer.whoop.com)
2. Create a new application
3. Set your privacy policy URL
4. Set the redirect URI to your server's callback URL (e.g., `https://your-domain.com/callback`)
5. Select all read scopes + `offline` (for refresh tokens)
6. Note your **Client ID** and **Client Secret**

### 2. Deploy to Your Server

```bash
git clone https://github.com/NealShankarGit/whoop-mcp-server.git
cd whoop-mcp-server
npm install
```

Create a `.env` file:

```env
WHOOP_CLIENT_ID=your_client_id
WHOOP_CLIENT_SECRET=your_client_secret
WHOOP_REDIRECT_URI=https://your-domain.com/callback
DB_PATH=/data/whoop.db
PORT=3000
MCP_MODE=http
```

Build and run:

```bash
mkdir -p /data
npm run build
node dist/index.js
```

### 3. Production Deployment (systemd + Nginx)

Create a systemd service at `/etc/systemd/system/whoop-mcp.service`:

```ini
[Unit]
Description=WHOOP MCP Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/whoop-mcp-server
ExecStart=/usr/bin/node dist/index.js
Restart=always
Environment=WHOOP_CLIENT_ID=your_client_id
Environment=WHOOP_CLIENT_SECRET=your_client_secret
Environment=WHOOP_REDIRECT_URI=https://your-domain.com/callback
Environment=DB_PATH=/data/whoop.db
Environment=PORT=3000
Environment=MCP_MODE=http

[Install]
WantedBy=multi-user.target
```

> **Note:** Use inline `Environment=` directives instead of `EnvironmentFile=`. The `EnvironmentFile` directive can silently fail to load variables, which breaks token encryption/decryption.

Nginx reverse proxy:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then add SSL:

```bash
certbot --nginx -d your-domain.com
systemctl daemon-reload
systemctl enable whoop-mcp
systemctl start whoop-mcp
```

### 4. Authorize with WHOOP

1. Visit `https://your-domain.com/health` to verify the server is running
2. In a Claude chat, use the `get_auth_url` tool to get the authorization link
3. Visit the link, log in to WHOOP, and authorize the app
4. You'll be redirected back and the initial 90-day sync begins automatically

### 5. Connect to Claude

1. Go to Claude.ai → Settings → Connectors
2. Click "Add custom connector"
3. Enter your server URL: `https://your-domain.com/mcp`
4. No OAuth credentials needed in advanced settings — auth is handled via the `get_auth_url` tool
5. Use it in any chat on any device

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WHOOP_CLIENT_ID` | WHOOP OAuth client ID | Required |
| `WHOOP_CLIENT_SECRET` | WHOOP OAuth client secret | Required |
| `WHOOP_REDIRECT_URI` | OAuth callback URL | `http://localhost:3000/callback` |
| `DB_PATH` | SQLite database path | `./whoop.db` |
| `PORT` | HTTP server port | `3000` |
| `MCP_MODE` | `http` for remote, `stdio` for local | `http` |

## Architecture

```
┌─────────────────────────────────────────────────┐
│              WHOOP MCP Server                   │
│                                                 │
│  ┌─────────────┐      ┌──────────────────┐    │
│  │ MCP Server  │◄────►│  SQLite Database │    │
│  │ (Streamable │      │  - cycles        │    │
│  │  HTTP)      │      │  - recovery      │    │
│  └─────────────┘      │  - sleep + naps  │    │
│         │             │  - workouts      │    │
│         │             │  - tokens (enc)  │    │
│         ▼             └──────────────────┘    │
│  ┌─────────────┐                               │
│  │ WHOOP API   │                               │
│  │ v2 Client   │                               │
│  └─────────────┘                               │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│  Claude.ai Custom Connector                     │
│  Desktop · Mobile · Web                         │
│  "What's my recovery today?"                    │
└─────────────────────────────────────────────────┘
```

## Bug Fixes in This Fork

### Express Middleware Conflict (Critical)
The original server applied `express.json()` globally, which consumed the request body before `StreamableHTTPServerTransport` could read it. This caused "Parse error: Invalid JSON" on every MCP request. Fixed by skipping `express.json()` on the `/mcp` route:

```typescript
app.use((req, res, next) => {
    if (req.path === '/mcp') return next();
    express.json()(req, res, next);
});
```

### Session Persistence Fix
The original 30-minute session TTL caused Claude's connector to silently lose connection between chats. Extended to 24 hours and added automatic expired session recovery — when a request arrives with an unknown or expired session ID, the server creates a new session instead of returning an error.

### Other Fixes
- **MCP SDK upgraded** from `^1.0.0` to `1.27.1` — original version had broken Streamable HTTP support
- **Zone duration null checks** — some workouts don't have HR zone data, causing crashes during sync
- **Nap timezone fix** — `getTodayNap()` now uses 24-hour window instead of UTC date comparison
- **Sleep Debt display** — shows "0h 0m" instead of "N/A" when debt is zero
- **systemd EnvironmentFile fix** — `EnvironmentFile` silently fails to load env vars; switched to inline `Environment=` directives to ensure token encryption key is always available

## WHOOP API v2 Endpoints Used

| Endpoint | Data |
|----------|------|
| `GET /v2/user/profile/basic` | User profile |
| `GET /v2/user/measurement/body` | Weight, height, max HR |
| `GET /v2/cycle` | Physiological cycles (strain) |
| `GET /v2/recovery` | Recovery scores, HRV, RHR, SpO2 |
| `GET /v2/activity/sleep` | Sleep records + naps |
| `GET /v2/activity/workout` | Workout records |

## Known Limitations

These WHOOP metrics are **not available** via the v2 API:
- **Sleep Latency** — tracked in WHOOP app but not exposed in API
- **Sleep Stress** — app-calculated metric, not in API
- **Steps** — WHOOP does not track steps
- **Tonnage** — Strength Trainer data not exposed in API (can be calculated from exercise data)

## License

MIT — See [LICENSE](LICENSE) for details.
