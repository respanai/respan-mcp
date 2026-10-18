# Respan MCP Server

Model Context Protocol (MCP) server for [Respan](https://respan.ai) - access logs, prompts, traces, and customer data directly from your AI assistant.

## Features

- **Logs and traces** - Query requests and inspect complete execution trees
- **Behaviors and errors** - Analyze quality signals, errors, and incidents
- **Monitors** - Manage alerts, versions, deployment, and delivery history
- **Prompts** - Manage prompt templates and versions
- **Datasets, experiments and evaluators** - Build datasets from logs, run experiments, test graders
- **Project settings** - API keys, caches, exports, webhooks, tags, saved views and limits
- **Tool search** - Everyday tools are listed; `tool_search` and `tool_run` reach the rest

---

## Quick Start

### Option 1: Public HTTP (Recommended)

No installation required.

1. Get your API key from [platform.respan.ai](https://platform.respan.ai/platform/api/api-keys)

2. Add to your MCP config file:

**Cursor** (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "respan": {
      "url": "https://mcp.respan.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_RESPAN_API_KEY"
      }
    }
  }
}
```

**Claude Desktop** (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "respan": {
      "url": "https://mcp.respan.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_RESPAN_API_KEY"
      }
    }
  }
}
```

3. Restart Cursor/Claude Desktop

**Read-only by default.** When you connect with OAuth (sign in through the browser instead of pasting a key), the client only gets tools that read your data. To let it create, update, deploy or delete, tick **Also allow changes** on the consent page. Calls to change tools from a read-only connection return an `insufficient_scope` error that explains how to reconnect. With an API key, the key's own permissions apply; create a key with read-only permissions for the same effect. OAuth connections made before this change keep their access until they expire.

**A URL that can never write.** `https://mcp.respan.ai/mcp/readonly` (and `/mcp/enterprise/readonly`) serves only read-only tools for every credential, OAuth or API key. A sign-in started from it grants read access only, and the consent page offers no "allow changes" option (this relies on the client sending the URL as its OAuth `resource`, or the `mcp:read` scope it advertises, as MCP clients do). Even a token that can write lists only read-only tools here. Use it when a connector must stay read-only whatever the user picks.

---

### Option 2: Local Stdio

Run the MCP server locally for personal development or offline use.

**Prerequisites:** Node.js v18+

```bash
git clone https://github.com/respanai/respan-mcp.git
cd respan-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "respan": {
      "command": "node",
      "args": ["/absolute/path/to/respan-mcp/dist/lib/index.js"],
      "env": {
        "RESPAN_API_KEY": "YOUR_RESPAN_API_KEY"
      }
    }
  }
}
```

---

### Option 3: Private HTTP (Teams)

Deploy your own instance to Vercel for teams sharing a single deployment.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/respanai/respan-mcp&env=RESPAN_API_KEY&envDescription=Your%20Respan%20API%20key&envLink=https://platform.respan.ai/platform/api/api-keys)

Set `RESPAN_API_KEY` in Vercel Dashboard > Settings > Environment Variables.

Share this config with your team:
```json
{
  "mcpServers": {
    "respan": {
      "url": "https://your-project.vercel.app/mcp"
    }
  }
}
```

---

## Tools

The server serves the in-product agent's customer tools under the backend's
names and contracts (`<resource>_<action>`: `log_list`, `metric_summary`,
`model_usage_list`, `dataset_log_create`), plus a few session tools of its own:
`project_list`, `project_switch`, `log_filter_schema_get` and
`behavior_disabled_set`. Workspaces (the tier above projects) are read with
`workspace_list`, `workspace_get`, `workspace_project_list` and
`workspace_member_list` (OAuth sessions). A project was once called an organization; old tool
names (`metrics_summary`, `org_switch`, `workspace_switch`, ...) stay callable
through `lib/shared/tool-aliases.ts`.

**Search and run.** `tools/list` shows ten everyday tools plus `tool_search` and
`tool_run`. `tool_search` ranks every other tool by resource and action words
(the backend admin MCP's ranking, with customer synonyms and stop words) and
returns input schemas for the top three and a one-line summary for the rest;
`tool_run(name, arguments)` runs one. To save context, listed descriptions keep
their first paragraph (300 characters) and argument descriptions are capped at
100 characters; `select:name` returns a tool's full description and schema. Second-line groups (automations, reports, caches, tags,
webhooks, ...) are folded: search finds them when the keywords name the group,
or with `include_folded=true`. Listed or not, every tool can also be called by
name. To list every tool at connect, send `Respan-Tool-List: all`, name the
tools in `Respan-Enabled-Tools`, or set `RESPAN_MCP_LIST_ALL=1` (stdio).

**Thin wrappers.** Each backend tool is one entry in
`lib/shared/backend-routes.ts`: the request its backend executor sends (method,
path, query and body keys, fixed values). One executor builds that request and
returns the server's answer; the server validates, defaults and shapes. A
tool's schema lists only the arguments its route sends. Two rules keep it safe:
no tool runs a Respan-chosen model (experiment and dataset eval runs send
`is_scoring_behaviors=false`; simulation, red-team and suggestion tools are not
served), and credential fields are stripped from every result.

**Read-only connections** (OAuth without "Also allow changes", or
`/mcp/readonly`) see only tools annotated read-only; `tool_run` refuses the rest
with `insufficient_scope`.

---

## Project Structure

```
respan-mcp/
├── api/                      # HTTP entry points (Vercel), OAuth and metadata routes
├── lib/
│   ├── index.ts              # Stdio entry point (local mode)
│   ├── generated/
│   │   └── backend-tools.json # backend tool catalog (names, descriptions, schemas)
│   ├── shared/
│   │   ├── mcp-handler.ts    # createServer and the hosted handler
│   │   ├── register-tools.ts # every tool the server registers
│   │   ├── backend-routes.ts # the request each backend tool sends
│   │   ├── backend-route.ts  # the generic thin executor
│   │   ├── tool-index.ts     # tool_search, tool_run, folded groups
│   │   ├── tool-aliases.ts   # old tool names -> current names
│   │   ├── tool-policy.ts    # read-only / destructive annotations, read-only removal
│   │   └── tool-result.ts    # size budgets, internal-field stripping
│   ├── production/filter-schema.ts # log_filter_schema_get
│   ├── pulses/settings.ts    # behavior_disabled_set
│   ├── account/projects.ts   # project_list, project_switch (workspace_* tools are routed)
│   └── oauth/                # OAuth 2.1 broker
├── vercel.json               # Vercel config (rewrites, function timeout)
└── package.json
```

### Syncing with the backend

`lib/generated/backend-tools.json` is a snapshot of the customer tool catalog the
in-product agent uses. To refresh it from a backend checkout:

```bash
cd ../respan-backend
./.venv/bin/python ../respan-mcp/scripts/export_backend_tools.py --out ../respan-mcp/lib/generated/backend-tools.json
```

A routed tool missing from the snapshot fails startup rather than disappearing.
A new backend tool is served once it has a route in `lib/shared/backend-routes.ts`.

### Telemetry

The hosted endpoints (`/mcp`, `/mcp/enterprise`, `/mcp/docs`) write one JSON line to stdout for each of these events. On Vercel the lines land in the runtime logs (`lib/shared/telemetry.ts`).

| `event` | When | Main fields |
|---|---|---|
| `mcp.tool_call` | Every well-formed `tools/call`, including calls whose arguments fail the tool's input schema and calls to a tool this server does not have (a request the SDK rejects as malformed JSON-RPC, such as non-object `arguments`, is not a tool call and is not logged) | `tool` (the current product name, also when the client called an old name), `category` (the tool's `respan/category`; absent for a tool this server does not have), `alias_used` and, when it is true, `alias` (the old name the client sent), `status` (`ok`, `tool_error`, `exception`, `invalid_arguments`, `unknown_tool`), `latency_ms`, `result_chars`, `arg_keys` (the names the client sent), `http_status`, `error_class` |
| `mcp.session_init` | An `initialize` the server completed | `client_name`, `client_version`, `requested_protocol_version` |
| `mcp.tool_alias` | A request whose `tools/call` used an old tool name, written even when the transport rejects the request and no `mcp.tool_call` follows (old names in the `Respan-Enabled-Tools` header are not counted) | `old_names` |

Every line also carries `realm`, `auth_kind` (`oauth`, `jwt`, `api_key`, `env`, `none`), `user_agent`, `protocol_version` and, when there is a bearer, `session_key`. The `session_key` is the first 12 hex characters of a SHA-256 of the bearer under a fixed telemetry prefix, so the stateless calls made with one credential can be grouped together but the key cannot be matched against the token hashes the OAuth session store keeps. It changes when an OAuth or JWT token is refreshed, and `/mcp/docs`, which takes no credential, logs none. One request writes at most 50 `mcp.tool_call` lines, and name lists are capped at 32 entries.

Argument values, tool results and credentials are never logged. stdio is not instrumented, because there stdout carries the protocol and the process runs on the user's machine.

---

## Enterprise Configuration

For custom API endpoints, set the `RESPAN_API_BASE_URL` environment variable:

**Stdio mode:**
```json
{
  "mcpServers": {
    "respan": {
      "command": "node",
      "args": ["/path/to/respan-mcp/dist/lib/index.js"],
      "env": {
        "RESPAN_API_KEY": "YOUR_API_KEY",
        "RESPAN_API_BASE_URL": "https://your-endpoint.example.com/api"
      }
    }
  }
}
```

**Private deployment:** Set `RESPAN_API_BASE_URL` in Vercel environment variables.

---

## Local Development

```bash
npm run build        # Compile TypeScript
npm run stdio        # Build and run in stdio mode
npm run check        # Type-check the source, tests and scripts, then run the tests
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check` and
`npm run build` on every pull request. Vercel deploys main to Production on
merge without running tests, so a red check means the change is not ready to
merge.

`tests/tool-surface.test.ts` checks every tool clients see:
- the tool name;
- the description length (Claude Code truncates past 2,048 characters);
- that the input schema compiles;
- the tool names, the total `tools/list` size (up to 10% growth is allowed)
  and which tools lack a title (a new tool must have one), against
  `tests/fixtures/tool-surface.baseline.json`.

If you add, remove or rename tools, or grow the list past the allowance, the
check fails: run `npm run surface:update` and commit the new baseline with the
change, so the name and size diff show up in review.

### Local OAuth broker

The repository includes a Vercel-independent HTTP harness for the public OAuth
and MCP routes. It uses the existing local backend and Redis services; it does
not start, restart, or clear either service.

Create a gitignored `.env.local`:

```dotenv
OAUTH_SECRET=<locally-generated-random-secret-of-at-least-32-characters>
OAUTH_SESSION_STORE=redis
REDIS_URL=redis://127.0.0.1:6379/15
MCP_REDIS_KEY_PREFIX=respan-mcp:local:
MCP_PUBLIC_BASE_URL=http://127.0.0.1:3100
MCP_ACCESS_TOKEN_TTL_SECONDS=60
RESPAN_API_BASE_URL=http://127.0.0.1:8000/api
RESPAN_ENTERPRISE_API_BASE_URL=http://127.0.0.1:8000/api

# Used only by the complete local verification probe:
OAUTH_TEST_EMAIL=<local-test-account-email>
OAUTH_TEST_PASSWORD=<local-test-account-password>
# Required by the platform probe's API-key compatibility check.
OAUTH_TEST_API_KEY=<local-test-api-key>
# Optional; defaults to platform. Also accepts enterprise.
OAUTH_TEST_REALM=platform
```

To exercise the same Upstash REST adapter used by Vercel, replace the local
Redis settings with:

```dotenv
OAUTH_SESSION_STORE=upstash
UPSTASH_REDIS_REST_URL=<upstash-rest-url>
UPSTASH_REDIS_REST_TOKEN=<upstash-rest-token>
```

Keep the local key prefix distinct from Preview and Production. The probe
always replaces it with a unique per-run prefix and deletes only those keys.

For manual browser testing, run the local service:

```bash
npm run dev:oauth
```

The automated verification command launches its own isolated broker harness,
so run it without a separate `dev:oauth` process:

```bash
npm run verify:oauth:local
```

To exercise the same lifecycle through the enterprise resource and backend,
run:

```bash
OAUTH_TEST_REALM=enterprise npm run verify:oauth:local
```

To verify that refresh rotation does not extend an absolute refresh-session
deadline, run the probe with a short local lifetime:

```bash
OAUTH_VERIFY_REFRESH_EXPIRY=true \
MCP_REFRESH_SESSION_TTL_SECONDS=180 \
npm run verify:oauth:local
```

The probe rotates the refresh token after the access token expires, waits until
three minutes from the original session issuance, and then requires
`invalid_grant` from the latest refresh token. This setting is for local
verification only.

The probe starts its own isolated harness on `127.0.0.1:3100`, uses a unique
Redis key prefix, prints only step status and duration, and removes only keys
under that unique prefix. Do not run `dev:oauth` simultaneously on the same
port. Google login requires separately configured local backend credentials;
the deterministic automated suite covers the broker behavior without them.

Hosted OAuth client registrations accept HTTPS callbacks and HTTP callbacks
bound to loopback — the literal addresses `127.0.0.1` and `[::1]`, or the
hostname `localhost`, which is what Claude Code and the MCP Inspector register.
The hostname match is exact, so `localhost.attacker.example` and
`sub.localhost` are not loopback. Other HTTP hosts, executable URL schemes,
credentials, fragments, duplicate callbacks, and oversized callback lists are
rejected.

Vercel deployments require Upstash rather than the in-memory store. Production
public and backend URLs must use HTTPS, and OAuth secrets and Redis credentials
must be configured only through the deployment secret manager.

For the complete Preview and Production setup, environment-variable matrix,
Vercel service configuration, verification gate, monitoring, and rollback
procedure, see [Public MCP OAuth Broker: Vercel Deployment Runbook](docs/vercel-oauth-deployment.md).

Automated checks:

```bash
npm run check
TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm test -- --run tests/redis-store.integration.test.ts
npm run build
git diff --check
```

---

## Documentation

Full documentation at [docs.respan.ai/documentation/resources/mcp](https://docs.respan.ai/documentation/resources/mcp)

## License

MIT

### Shared CLI/MCP discovery

Each registered tool carries `_meta["respan/category"]`. Product names are listed
by discovery; compatible backend/older names are rewritten at the transport
boundary. Enabled-tool settings accept either vocabulary. Backend names, wire
parameters and APIs can be reused by multiple features without duplicating the
CLI catalog.

Behavior drill-down returns `trace_unique_id` for whole-trace verdicts; inspect
that run using `trace_get`. Trace details distinguish whole-trace verdicts from
span-aggregation fallback. Response fields named `*_spans` count traces when the
selected scope is traces.
