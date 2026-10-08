// lib/shared/tool-aliases.ts
//
// Tools were renamed to the backend's own names (noun_verb, e.g. log_list) so
// this server and the in-product agent share one vocabulary. Clients that
// still use an old name keep working: old names in the Respan-Enabled-Tools
// header and in tools/call requests are translated to the new ones. Only the
// new names are listed by tools/list.

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
  list_prompt_versions: "prompt_versions_list",
  get_prompt_version_detail: "prompt_version_get",
  create_prompt_version: "prompt_draft_init",
  update_prompt_version: "prompt_version_update",
  deploy_prompt_version: "prompt_deploy",
  list_experiments: "experiment_list",
  get_experiment: "experiment_get",
  create_experiment: "experiment_create",
  delete_experiment: "experiment_delete",
  list_experiment_spans: "experiment_logs_list",
  get_experiment_span: "experiment_log_get",
  get_experiment_score_averages: "experiment_score_averages",
  list_workflows: "workflow_list",
  filter_workflows: "workflow_filter",
  get_workflow: "workflow_get",
  create_workflow: "workflow_create",
  create_automation_workflow: "automation_create",
  create_monitor_workflow: "monitor_create",
  create_export_workflow: "export_workflow_create",
  create_workflow_draft: "workflow_draft_create",
  update_workflow: "workflow_update",
  delete_workflow: "workflow_delete",
  list_workflow_versions: "workflow_versions_list",
  get_workflow_version: "workflow_version_get",
  commit_workflow: "workflow_commit",
  deploy_workflow: "workflow_deploy",
  undeploy_workflow: "workflow_undeploy",
  validate_workflow: "workflow_validate",
  list_datasets: "dataset_list",
  get_dataset: "dataset_get",
  create_dataset: "dataset_create",
  update_dataset: "dataset_update",
  delete_dataset: "dataset_delete",
  list_dataset_logs: "dataset_logs_list",
  retrieve_dataset_log: "dataset_log_get",
  replace_dataset_log: "dataset_log_replace",
  import_dataset_logs: "dataset_logs_import",
  remove_dataset_logs: "dataset_logs_remove",
  summarize_dataset_logs: "dataset_logs_summary",
  bulk_create_dataset_logs: "dataset_logs_bulk_create",
  list_dataset_eval_runs: "dataset_eval_runs_list",
  list_evaluators: "grader_list",
  get_evaluator: "grader_get",
  create_evaluator: "grader_create",
  update_evaluator: "grader_update",
  delete_evaluator: "grader_delete",
  test_evaluator: "grader_run",
  commit_evaluator: "grader_commit",
  list_evaluator_versions: "grader_versions_list",
  list_evaluation_pipelines: "evaluator_list",
  get_evaluation_pipeline: "evaluator_get",
  create_evaluation_pipeline: "evaluator_create",
  update_evaluation_pipeline: "evaluator_update",
  list_organizations: "org_list",
  switch_organization: "org_switch",
  search_docs: "docs_search",
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
