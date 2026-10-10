# Respan MCP Server

Model Context Protocol (MCP) server for [Respan](https://respan.ai) - access logs, prompts, traces, and customer data directly from your AI assistant.

## Features

- **Logs** - Query, filter, and create LLM request logs
- **Traces** - View complete execution traces with span trees
- **Customers** - Access customer data and budget information
- **Prompts** - Manage prompt templates and versions

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

## Available Tools

Tool names match the ones the in-product Respan agent uses (`noun_verb`, such as `log_list` or `prompt_deploy`). Older names (`list_logs`, `get_trace_tree`, `deploy_prompt_version`, ...) still work in the `Respan-Enabled-Tools` header and in `tools/call`; they are translated to the current names (`lib/shared/tool-aliases.ts`), and only current names are listed.

### Organizations

| Tool | Description |
|------|-------------|
| `org_list` | List the organizations your account can act as, and which one is active |
| `org_switch` | Switch the active organization by name, `organization_id`, or `team_id` |

Every other tool reads and writes the **active** organization only. Switching is
account-wide and persistent — it moves the Respan web app and any other session
to the same organization, because the backend stores the active organization on
the user record rather than on the token. Requires an OAuth login; an API key is
already bound to one organization and cannot switch.

### Production

What is happening in your app. Every tool here is read-only and defaults to the last 24 hours.

| Tool | Description |
|------|-------------|
| `log_list` | Find individual requests and spans (compact rows, no message text) |
| `log_get` | Read one request in full: messages, output, cost, tokens, scores |
| `trace_list` | Find agent or workflow runs, with per-run totals |
| `trace_get` | Read one run as a tree of spans |
| `thread_list` | Find conversations (requests sharing a `thread_identifier`) |
| `thread_get` | Read one conversation's totals |
| `dashboard_llm_metrics_summary` | Requests, cost, tokens, latency and error rate for a time range |
| `dashboard_top_models` | Rank models by requests, cost, tokens, errors or latency |
| `end_user_rank_by_usage` | Rank your app's end users the same way |

Results leave out Respan-internal fields (org and key IDs, pricing internals, storage keys, raw request copies) and long text is shortened to keep each result small.

### Behaviors and errors

What the platform flags on your traffic. Names, descriptions and arguments come straight from the backend's tool catalog.

| Tool | Description |
|------|-------------|
| `pulse_behaviors_summary` | How often each behavior fired, with a positive/negative/neutral rollup |
| `behavior_list` | The behaviors available to your organization (built-in and custom) |
| `behavior_timeseries` | Behavior counts over time |
| `behavior_grouped` | One behavior's count broken down by a log dimension |
| `behavior_spans_list` | The spans where one behavior fired |
| `custom_behavior_list` / `custom_behavior_get` | Your custom behaviors |
| `custom_behavior_suggest` / `custom_behavior_analyze` | Draft custom behaviors and check their wording (saves nothing) |
| `custom_behavior_create` / `custom_behavior_update` / `custom_behavior_delete` | Manage custom behaviors |
| `pulse_error_groups_list` / `pulse_error_group_get` | Error issues, grouped by fingerprint, and one issue's recent occurrences |
| `pulse_incidents_list` | Detected windows of elevated error rate |

### Prompts

| Tool | Description |
|------|-------------|
| `prompt_list` | List all prompts in your organization |
| `prompt_get` | Get detailed prompt information |
| `prompt_create` / `prompt_update` | Create a prompt, or change its name and settings |
| `prompt_versions_list` | List all versions of a prompt |
| `prompt_version_get` | Get specific version details |
| `prompt_draft_init` / `prompt_version_update` | Start a new draft version, or edit one |
| `prompt_commit` | Commit the current draft as a read-only version |
| `prompt_deploy` | Make a version live; a current draft is committed first |

### Workflows

| Tool | Description |
|------|-------------|
| `workflow_list` | List automations, monitors, scheduled exports, and evaluator pipelines |
| `workflow_filter` | Filter workflows by type or other fields |
| `workflow_get` | Retrieve a workflow and its task definitions |
| `automation_create` | Create an event-driven automation; adds the required dashboard sampling gate |
| `monitor_create` | Create a monitor from aggregation/condition and delivery tasks |
| `export_workflow_create` | Create a scheduled export from cron and export-specific options |
| `workflow_create` | Advanced low-level workflow creation escape hatch |
| `workflow_update` | Update an editable workflow draft |
| `workflow_delete` | Delete a workflow family and all versions |
| `workflow_versions_list` | List versions in a workflow family |
| `workflow_version_get` | Retrieve a specific workflow version |
| `workflow_commit` | Commit the current draft |
| `workflow_deploy` | Deploy a committed workflow version |
| `workflow_undeploy` | Stop a deployed workflow |
| `workflow_validate` | Validate workflow tasks against sample data |

The backend route is shared, but the MCP creation functions are intentionally separate. Automations are event-driven task pipelines and receive the dashboard-compatible `auto-sampling` gate; monitors accept aggregation, condition, and delivery tasks and require a notification or webhook; exports accept a UTC five-field cron plus export-specific filters, fields, inline-result behavior, and sampling.

---

## Filter Syntax

`log_list` and `trace_list` take common filters as plain parameters (`model`, `status`, `customer_identifier`, `errors_only`, ...). For anything else they accept an advanced `filters` array:

```json
[
  {"field": "latency", "operator": "gt", "value": [5]},
  {"field": "metadata__session_id", "operator": "", "value": ["abc123"]}
]
```

**Operators:** `""` (equal), `not`, `lt`, `lte`, `gt`, `gte`, `contains`, `icontains`, `startswith`, `endswith`, `in`, `isnull`

The request-log endpoints reject unknown fields with a 400 that names the problem. The traces endpoint silently ignores them, so `trace_list` checks its fields against the closed set the backend honours (see `lib/shared/filter-fields.ts`) and rejects the rest before sending. Custom `metadata__<key>` fields work on `log_list` only; traces have no metadata columns.

---

## Project Structure

```
respan-mcp/
├── api/
│   └── mcp.ts                # HTTP entry point (Vercel serverless function)
├── lib/
│   ├── index.ts              # Stdio entry point (local mode)
│   ├── generated/
│   │   └── backend-tools.json # backend tool catalog (names, descriptions, schemas)
│   ├── shared/
│   │   ├── client.ts         # API client, auth config, path validation
│   │   ├── backend-tool.ts   # registers a tool from the backend catalog
│   │   ├── tool-aliases.ts   # old tool names -> current names
│   │   ├── tool-policy.ts    # read-only / destructive annotations
│   │   └── tool-result.ts    # size budgets, internal-field stripping
│   ├── production/
│   │   ├── logs.ts           # log_list, log_get
│   │   ├── traces.ts         # trace_list, trace_get
│   │   ├── threads.ts        # thread_list, thread_get
│   │   └── metrics.ts        # dashboard_llm_metrics_summary, dashboard_top_models, end_user_rank_by_usage
│   ├── pulses/
│   │   └── index.ts          # behaviors, error issues, incidents
│   ├── account/
│   │   └── organizations.ts  # org_list, org_switch
│   └── develop/
│       └── prompts.ts        # prompt_list, prompt_get, versions
├── vercel.json               # Vercel config (rewrites, function timeout)
├── tsconfig.json             # TypeScript config
└── package.json
```

### Architecture

- **Two entry points:** `api/mcp.ts` (HTTP via Vercel) and `lib/index.ts` (stdio for local use)
- **Shared core:** Both entry points create an `AuthConfig` and pass it to the same tool registration functions via closures - no global mutable state
- **Tool modules:** Organized by domain (`production/` for runtime data, `develop/` for prompt management)
- **API client:** `lib/shared/client.ts` handles all upstream API calls with 30s timeout, path validation, and auth

### Syncing with the backend

`lib/generated/backend-tools.json` is a snapshot of the customer tool catalog the in-product agent uses. Tools registered with `registerBackendTool` take their name, description and arguments from it, and their handlers mirror the backend executor of the same name. To refresh it from a backend checkout:

```bash
cd ../respan-backend
./.venv/bin/python ../respan-mcp/scripts/export_backend_tools.py --out ../respan-mcp/lib/generated/backend-tools.json
```

If a tool this server registers was renamed or removed in the backend, startup fails loudly rather than dropping it.

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
npm run check        # Type-check src, tests and scripts, then run the tests
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check` and
`npm run build` on every pull request. Vercel deploys main to Production on
merge without running tests, so a red check means the change is not ready to
merge.

`tests/tool-surface.test.ts` checks every tool clients see:
- the tool name;
- the description length (Claude Code truncates past 2,048 characters);
- that the input schema compiles;
- the total `tools/list` size and which tools lack a title, against
  `tests/fixtures/tool-surface.baseline.json`.

If you add or change tools on purpose and the size check fails, run
`npm run surface:update` and commit the new baseline with the change. The
size diff then shows up in review.

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
