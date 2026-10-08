// lib/pulses/index.ts
//
// Behaviors and errors: what the platform flags on production traffic.
// Contracts come from the backend catalog; each handler mirrors the backend
// executor of the same name (admin/mcp_server/behavior_tools.py and
// pulse_tools.py in respan-backend).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch } from "../shared/client.js";
import { passedArgs, pickArgs, registerBackendTool } from "../shared/backend-tool.js";
import { READ_ONLY_WORKSPACE_TOOL } from "../shared/tool-result.js";
import { ADDITIVE_WRITE_TOOL, DESTRUCTIVE_TOOL } from "../shared/tool-policy.js";

const BEHAVIORS_PATH = "/api/pulses/behaviors/";
const CUSTOM_BEHAVIORS_PATH = `${BEHAVIORS_PATH}custom/`;
const TIME_WINDOW_KEYS = ["start_time", "end_time", "environment"] as const;
const DEFINITION_KEYS = ["name", "description", "polarity"] as const;

/** POST-for-filtering analytics reads: path and the body keys they honor. */
const BEHAVIOR_ANALYTICS: Record<string, { path: string; bodyKeys: readonly string[] }> = {
  pulse_behaviors_summary: { path: BEHAVIORS_PATH, bodyKeys: TIME_WINDOW_KEYS },
  behavior_timeseries: {
    path: `${BEHAVIORS_PATH}timeseries/`,
    bodyKeys: [...TIME_WINDOW_KEYS, "scope", "granularity", "group_by", "behaviors"],
  },
  behavior_grouped: {
    path: `${BEHAVIORS_PATH}grouped/`,
    bodyKeys: [...TIME_WINDOW_KEYS, "scope", "behavior", "group_by", "limit"],
  },
  behavior_spans_list: {
    path: `${BEHAVIORS_PATH}logs/`,
    bodyKeys: [...TIME_WINDOW_KEYS, "scope", "behavior", "page", "page_size"],
  },
};

/** Error-issue fingerprints, as pulse_error_groups_list returns them. */
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function customBehaviorPath(args: Record<string, any>): string {
  return `${CUSTOM_BEHAVIORS_PATH}${encodeURIComponent(String(args.behavior_id ?? ""))}/`;
}

export function registerPulseTools(server: McpServer, client: AuthenticatedClient | null) {
  // --- Behaviors ---
  for (const [name, route] of Object.entries(BEHAVIOR_ANALYTICS)) {
    registerBackendTool(server, client, name, READ_ONLY_WORKSPACE_TOOL, (c, args) =>
      rawFetch(c, route.path, { body: pickArgs(args, route.bodyKeys) }),
    );
  }

  registerBackendTool(server, client, "behavior_list", READ_ONLY_WORKSPACE_TOOL, (c) =>
    rawFetch(c, "/api/request-logs/behavior-columns/", { method: "GET" }),
  );

  registerBackendTool(server, client, "custom_behavior_list", READ_ONLY_WORKSPACE_TOOL, (c, args) =>
    rawFetch(c, CUSTOM_BEHAVIORS_PATH, {
      method: "GET",
      query: { page: args.page, page_size: args.page_size, tags: args.tags || undefined },
    }),
  );

  registerBackendTool(server, client, "custom_behavior_get", READ_ONLY_WORKSPACE_TOOL, (c, args) =>
    rawFetch(c, customBehaviorPath(args), { method: "GET" }),
  );

  // Suggest and analyze save nothing, but each runs a billed LLM call.
  registerBackendTool(server, client, "custom_behavior_suggest", ADDITIVE_WRITE_TOOL, (c, args) =>
    rawFetch(c, `${CUSTOM_BEHAVIORS_PATH}suggestions/`, {
      body: pickArgs(args, ["agent_description", "max_suggestions", "existing_behaviors"]),
    }),
  );

  registerBackendTool(server, client, "custom_behavior_analyze", ADDITIVE_WRITE_TOOL, (c, args) =>
    args.descriptions?.length
      ? rawFetch(c, `${CUSTOM_BEHAVIORS_PATH}analyze-definitions/`, {
        body: { descriptions: args.descriptions },
      })
      : rawFetch(c, `${CUSTOM_BEHAVIORS_PATH}analyze-definition/`, {
        body: { description: args.description },
      }),
  );

  registerBackendTool(server, client, "custom_behavior_create", ADDITIVE_WRITE_TOOL, (c, args) =>
    rawFetch(c, CUSTOM_BEHAVIORS_PATH, { body: passedArgs(args, DEFINITION_KEYS) }),
  );

  registerBackendTool(server, client, "custom_behavior_update", DESTRUCTIVE_TOOL, (c, args) =>
    rawFetch(c, customBehaviorPath(args), { method: "PATCH", body: passedArgs(args, DEFINITION_KEYS) }),
  );

  registerBackendTool(server, client, "custom_behavior_delete", DESTRUCTIVE_TOOL, (c, args) =>
    rawFetch(c, customBehaviorPath(args), { method: "DELETE" }),
  );

  // --- Errors and incidents ---
  // /api/pulses/errors/ has no pagination: it returns the full top-200 ranking.
  registerBackendTool(server, client, "pulse_error_groups_list", READ_ONLY_WORKSPACE_TOOL, (c, args) =>
    rawFetch(c, "/api/pulses/errors/", {
      body: pickArgs(args, [...TIME_WINDOW_KEYS, "error_class", "provider", "status", "fault_domain"]),
    }),
  );

  registerBackendTool(server, client, "pulse_error_group_get", READ_ONLY_WORKSPACE_TOOL, async (c, args) => {
    const fingerprint = String(args.fingerprint ?? "");
    if (!FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new Error(
        `Invalid fingerprint ${JSON.stringify(fingerprint)}: pass an issue's error_fingerprint exactly as pulse_error_groups_list returned it.`,
      );
    }
    return rawFetch(c, `/api/pulses/errors/${encodeURIComponent(fingerprint)}/`, {
      body: pickArgs(args, [...TIME_WINDOW_KEYS, "limit"]),
    });
  });

  registerBackendTool(server, client, "pulse_incidents_list", READ_ONLY_WORKSPACE_TOOL, (c, args) =>
    rawFetch(c, "/api/pulses/incidents/", {
      query: { page: args.page, page_size: args.page_size },
      body: pickArgs(args, [...TIME_WINDOW_KEYS, "state", "severity", "fault_domain"]),
    }),
  );
}
