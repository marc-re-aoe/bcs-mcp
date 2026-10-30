# bcs-mcp

MCP server for [Projektron BCS](https://www.projektron.de/) time tracking. Connects Claude Desktop (or any MCP client) to BCS so you can book your work week via natural language.

## What it does

BCS has no public API — it uses server-side rendered HTML forms. This server scrapes and submits those forms, exposing 9 MCP tools:

| Tool | Description |
|------|-------------|
| `bcs_get_week_summary` | Week overview (Mon-Fri) with per-day attendance, day type, booked/unbooked hours |
| `bcs_get_day_summary` | Day detail: attendance, projects, booked/unbooked hours, day type (workday/holiday/absence) |
| `bcs_get_tasks` | List bookable tasks for a project |
| `bcs_book_effort` | Book time to a task (always creates a new entry) |
| `bcs_edit_effort` | Edit an existing booked effort entry's time and/or description in place |
| `bcs_delete_effort` | Delete a booked effort entry |
| `bcs_set_attendance` | Set attendance times (start, end, pause) |
| `bcs_get_overtime_balance` | Working time account: flexi-time balance, target vs actual hours |
| `bcs_get_vacation_status` | Vacation budget + absences list (vacation, sick, comp time) with optional year filter |

## Prerequisites

- Node.js 18+
- pnpm
- A Projektron BCS account with day effort recording enabled

## Setup

```bash
git clone <repo-url> && cd bcs-mcp
pnpm install
cp .env.example .env
```

Fill in `.env`:

```env
BCS_URL=https://your-bcs-instance.example.com
BCS_USERNAME=your-username
BCS_PASSWORD=your-password
BCS_USER_OID=your-user-oid
PORT=3000

# Optional: only needed if 2FA (TOTP) is enabled on your BCS account
BCS_TOTP_SECRET=your-base32-totp-secret
```

To find your `BCS_USER_OID`: open BCS, navigate to day effort recording, and look for the `oid` query parameter in the URL.

### Booking view (day vs. week)

By default `bcs_get_tasks`, `bcs_book_effort`, `bcs_edit_effort` and `bcs_delete_effort` use the BCS *day* view (Tagesbuchen). That only works if your saved day layout shows the task tree ("Aufgabenbaum"), and some BCS versions lock saved bookings there. Set

```env
BCS_BOOKING_VIEW=week
```

to use the *week* view (Wochenbuchen) instead: independent of your layout, one entry per task and day (`taskLineOid` = the task OID from `bcs_get_tasks`, `projectOid` is optional). Editing and deleting work by rewriting or clearing that cell. Tasks that BCS shows read-only (locked bookings) are rejected with an error. Attendance, day/week summaries, vacation and overtime still read the day view and other pages and are unaffected by this switch.

### SSO / OIDC login

If your BCS uses SSO (OIDC), there is no password to send: BCS itself handles the IdP redirect. Log in to BCS in your browser, then copy the `JSESSIONID` and `CSRF_Token` cookies (devtools → Application/Storage → Cookies) into:

```env
BCS_SESSION_ID=<JSESSIONID value>
BCS_CSRF_TOKEN=<CSRF_Token value>
```

When both are set, `BCS_USERNAME`, `BCS_PASSWORD` and `BCS_TOTP_SECRET` are not needed and are ignored. The server cannot renew an SSO session: when BCS expires it, requests fail with an error telling you to log in again and update the two values (restart the server/client afterwards).

`BCS_TOTP_SECRET` is the Base32-encoded secret from your authenticator app setup. If your BCS account does not use 2FA, leave it empty or omit it entirely.

## Build and run

```bash
pnpm build
pnpm start         # starts HTTP server on PORT (default 3000)
pnpm start:stdio   # starts in stdio mode (for Claude Desktop)
```

For development:

```bash
pnpm dev           # build with watch mode
pnpm test          # run tests
```

### Secret scanning (gitleaks)

Commits are scanned for secrets by a [prek](https://github.com/j178/prek) pre-commit hook (`.pre-commit-config.yaml`, gitleaks). Enable it once per clone:

```bash
prek install    # or: pre-commit install
```

CI runs `gitleaks git` over the full history on every PR and every push to `main`; a finding fails the pipeline and blocks the release. Never commit `.env` or the SSO cookies. If a secret was committed, rotate it, then rewrite history or add a justified entry to a `.gitleaksignore` file.

## Claude Desktop integration

### Stdio (recommended)

Claude Desktop launches and manages the server process directly. Add to your `claude_desktop_config.json`:

**macOS / Linux:**

```json
{
  "mcpServers": {
    "bcs": {
      "command": "node",
      "args": ["/absolute/path/to/bcs-mcp/dist/index.js", "--stdio"],
      "env": {
        "BCS_URL": "https://your-bcs-instance.example.com",
        "BCS_USERNAME": "your-username",
        "BCS_PASSWORD": "your-password",
        "BCS_USER_OID": "your-user-oid"
      }
    }
  }
}
```

**Windows (native Node.js):**

Same as above. Use a Windows-style path for `args` (e.g. `"C:\\Users\\you\\bcs-mcp\\dist\\index.js"`).

**Windows with WSL:**

If the project lives inside WSL, use `wsl.exe` to bridge into the Linux environment:

```json
{
  "mcpServers": {
    "bcs": {
      "command": "wsl.exe",
      "args": ["bash", "-ic", "node /absolute/path/to/bcs-mcp/dist/index.js --stdio"],
      "env": {
        "BCS_URL": "https://your-bcs-instance.example.com",
        "BCS_USERNAME": "your-username",
        "BCS_PASSWORD": "your-password",
        "BCS_USER_OID": "your-user-oid"
      }
    }
  }
}
```

Env vars in the config override `.env` file values. If a `.env` file exists, it is also loaded.

### HTTP (for development / debugging)

Start the server manually, then connect via URL:

```json
{
  "mcpServers": {
    "bcs": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Config file location:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Then ask Claude something like:

> "Book 2 hours on project X, task Y for today with description 'API integration'"

> "Show me my week summary"

> "How many vacation days do I have left?"

## Docker / Bifrost

```bash
docker build -t bcs-mcp .
docker run --rm -p 3000:3000 --env-file .env bcs-mcp   # MCP endpoint: http://localhost:3000/mcp, probe: /health
```

Register it in Bifrost as an HTTP MCP client with the URL `http://<container-host>:3000/mcp`. Configuration is via environment variables only (`BCS_URL`, `BCS_USER_OID`, and either `BCS_USERNAME`/`BCS_PASSWORD` or the SSO cookies `BCS_SESSION_ID`/`BCS_CSRF_TOKEN`, plus optional `BCS_TOTP_SECRET`, `BCS_BOOKING_VIEW`, `PORT`). Pass them from your secret store, never bake them into the image.

- Images are built and pushed to `ghcr.io/<owner>/bcs-mcp:<version>` (and `:latest`) by the release pipeline on every merge to `main` that contains a `feat:`/`fix:` commit; see `docs/release.md`.
- One container per BCS user: it acts as that user, and the `/mcp` endpoint has no authentication of its own. Keep it on a private network behind Bifrost.
- SSO cookies expire on the BCS side and cannot be renewed by the container; with password login the server re-authenticates itself.

## Architecture

```
src/index.ts   — Entry point (--stdio for stdio transport, default: HTTP)
src/server.ts  — MCP session management and request routing
src/tools.ts   — MCP tool definitions (9 tools, input schemas, response formatting)
src/api.ts     — BCS form-based API (HTML parsing, form submission)
src/auth.ts    — BCS authentication (login, CSRF tokens, session persistence)
```

## How it works

1. **Login** — POST to `/bcs/login` with credentials, capture `JSESSIONID` + `CSRF_Token` cookies. If 2FA is enabled, the TOTP code is generated automatically from `BCS_TOTP_SECRET`. Sessions are cached locally (30 min TTL).
2. **Read** — GET the day effort recording page (~600KB HTML), parse all form fields (~400+). Days are classified as `workday`, `holiday`, or `absence` based on attendance and event records.
3. **Expand** — AJAX request to expand project tree nodes and reveal bookable tasks.
4. **Book** — Append a new effort row to the form state, POST the entire form back. Each booking always creates a new entry (dual-path strategy for empty vs. occupied task rows).
5. **Verify** — Re-read the page after booking to confirm the entry was saved.
6. **Overtime** — AJAX lazy-load request to the notification board retrieves the working time account balance (flexi-time, target/actual hours).
7. **Vacation** — GET the vacation page, parse the budget table (total, used, planned, available days).

## License

ISC
