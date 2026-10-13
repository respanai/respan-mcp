// lib/shared/tool-aliases.ts
//
// Product-facing names are listed by discovery. Compatible legacy names in
// tools/call and Respan-Enabled-Tools are translated at the transport boundary.

/** Old tool name → current tool name. */
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  list_logs: "log_list",
  get_log_detail: "log_get",
  list_traces: "trace_list",
  get_trace_tree: "trace_get",
  list_prompts: "prompt_list",
  get_prompt_detail: "prompt_get",
  create_prompt: "prompt_create",
  update_prompt: "prompt_update",
  list_prompt_versions: "prompt_version_list",
  get_prompt_version_detail: "prompt_version_get",
  create_prompt_version: "prompt_draft_init",
  update_prompt_version: "prompt_draft_update",
  deploy_prompt_version: "prompt_deploy",
  create_monitor_workflow: "monitor_create",
  list_organizations: "workspace_list",
  switch_organization: "workspace_switch",
  search_docs: "docs_search",
  pulse_behaviors_summary: "behavior_summary",
  behavior_spans_list: "behavior_records",
  pulse_error_groups_list: "error_group_list",
  pulse_error_group_get: "error_group_get",
  pulse_incidents_list: "incident_list",
  dashboard_llm_metrics_summary: "metrics_summary",
  dashboard_top_models: "metrics_grouped",
  end_user_rank_by_usage: "user_usage_list",
  monitor_run_history: "monitor_alert_list",
  monitor_runs_time_series: "monitor_alert_timeseries",
  notification_method_list: "notification_destination_list",
  notification_method_get: "notification_destination_get",
  prompt_versions_list: "prompt_version_list",
  prompt_version_update: "prompt_draft_update",
  org_list: "workspace_list",
  org_switch: "workspace_switch",

};

/** The current name for `name`, which may be an old one. */
export function resolveToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

/**
 * Rewrites old tool names in a JSON-RPC request body (one message or a batch)
 * so `tools/call` reaches the renamed tool. Returns the old names it rewrote.
 */
export function rewriteToolCallNames(body: unknown): string[] {
  const rewritten: string[] = [];
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
    if (method !== "tools/call" || !params || typeof params.name !== "string") continue;
    const current = resolveToolName(params.name);
    if (current !== params.name) {
      rewritten.push(params.name);
      params.name = current;
    }
  }
  return rewritten;
}
