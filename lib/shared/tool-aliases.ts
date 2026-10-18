// lib/shared/tool-aliases.ts
//
// Tools carry the backend's names. Old names in tools/call, tool_run and
// Respan-Enabled-Tools are translated at the transport boundary.

/** Old tool name → current tool name. */
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  // Names before the backend's naming grammar (product names of #37).
  // Project terms: a project was an organization.
  org_list: "project_list",
  org_switch: "project_switch",
  org_get: "project_get",
  org_member_list: "project_member_list",
  workspace_switch: "project_switch",
  workspace_current: "project_get",
  metrics_summary: "metric_summary",
  metrics_timeseries: "metric_chart_get",
  error_timeseries: "metric_chart_get",
  metrics_grouped: "model_usage_list",
  user_usage_list: "end_user_usage_list",
  behavior_records: "behavior_span_list",
  behavior_settings_get: "project_get",
  behavior_settings_update: "behavior_disabled_set",
  guardrail_summary: "behavior_guardrail_summary",
  guardrail_timeseries: "behavior_guardrail_timeseries",
  guardrail_grouped: "behavior_guardrail_grouped",
  guardrail_list: "behavior_guardrail_settings_get",
  log_filter_schema: "log_filter_schema_get",
  monitor_alert_list: "monitor_run_history",
  monitor_alert_timeseries: "monitor_run_timeseries",
  notification_destination_list: "notification_method_list",
  notification_destination_get: "notification_method_get",
  prompt_draft_init: "prompt_draft_create",
  prompt_draft_update: "prompt_version_update",
  // Older names.
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
  create_prompt_version: "prompt_draft_create",
  update_prompt_version: "prompt_version_update",
  deploy_prompt_version: "prompt_deploy",
  create_monitor_workflow: "monitor_create",
  list_organizations: "project_list",
  switch_organization: "project_switch",
  search_docs: "docs_search",
  pulse_behaviors_summary: "behavior_summary",
  behavior_spans_list: "behavior_span_list",
  pulse_error_groups_list: "error_group_list",
  pulse_error_group_get: "error_group_get",
  pulse_incidents_list: "incident_list",
  dashboard_llm_metrics_summary: "metric_summary",
  dashboard_top_models: "model_usage_list",
  end_user_rank_by_usage: "end_user_usage_list",
  monitor_runs_time_series: "monitor_run_timeseries",
  prompt_versions_list: "prompt_version_list",
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
