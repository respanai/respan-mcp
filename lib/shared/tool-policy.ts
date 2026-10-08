// lib/shared/tool-policy.ts
//
// One table of MCP tool annotations for every tool registered through the
// legacy `server.tool(...)` API, so each tool tells clients whether it only
// reads, changes data, or deletes/overwrites it. ChatGPT plugin review
// requires readOnlyHint, destructiveHint and openWorldHint on every tool, and
// ChatGPT asks the user to confirm calls that are not read-only.
//
// Tools registered with `registerTool(...)` declare their own annotations and
// pass through untouched.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Reads the caller's workspace and changes nothing. */
const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Reads public Respan documentation. */
const READ_PUBLIC: ToolAnnotations = { ...READ, openWorldHint: true };

/** Adds something new to the workspace without changing what exists. */
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Deletes or overwrites data, or changes what runs in production. */
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** Sends real notifications and webhooks, which cannot be taken back. */
const SENDS_MESSAGES: ToolAnnotations = { ...DESTRUCTIVE, openWorldHint: true };

export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = {
  // Logs, traces, customers
  list_logs: READ,
  get_log_detail: READ,
  get_spans_summary: READ,
  list_traces: READ,
  get_trace_tree: READ,
  list_customers: READ,
  get_customer_detail: READ,

  // Prompts
  list_prompts: READ,
  get_prompt_detail: READ,
  list_prompt_versions: READ,
  get_prompt_version_detail: READ,
  create_prompt: WRITE,
  create_prompt_version: WRITE,
  update_prompt: DESTRUCTIVE,
  update_prompt_version: DESTRUCTIVE,

  // Experiments
  list_experiments: READ,
  get_experiment: READ,
  list_experiment_spans: READ,
  get_experiment_span: READ,
  get_experiment_score_averages: READ,
  create_experiment: WRITE,
  delete_experiment: DESTRUCTIVE,

  // Workflows
  list_workflows: READ,
  filter_workflows: READ,
  get_workflow: READ,
  list_workflow_versions: READ,
  get_workflow_version: READ,
  create_workflow: WRITE,
  create_automation_workflow: WRITE,
  create_monitor_workflow: WRITE,
  create_export_workflow: WRITE,
  create_workflow_draft: WRITE,
  commit_workflow: WRITE,
  update_workflow: DESTRUCTIVE,
  deploy_workflow: DESTRUCTIVE,
  undeploy_workflow: DESTRUCTIVE,
  delete_workflow: DESTRUCTIVE,
  validate_workflow: SENDS_MESSAGES,

  // Datasets
  list_datasets: READ,
  get_dataset: READ,
  list_dataset_logs: READ,
  retrieve_dataset_log: READ,
  summarize_dataset_logs: READ,
  list_dataset_eval_runs: READ,
  create_dataset: WRITE,
  import_dataset_logs: WRITE,
  bulk_create_dataset_logs: WRITE,
  update_dataset: DESTRUCTIVE,
  replace_dataset_log: DESTRUCTIVE,
  remove_dataset_logs: DESTRUCTIVE,
  delete_dataset: DESTRUCTIVE,

  // Evaluators (graders) and evaluation pipelines
  list_evaluators: READ,
  get_evaluator: READ,
  list_evaluator_versions: READ,
  create_evaluator: WRITE,
  commit_evaluator: WRITE,
  // A dry run that saves nothing, but it makes a billed LLM call.
  test_evaluator: WRITE,
  update_evaluator: DESTRUCTIVE,
  delete_evaluator: DESTRUCTIVE,
  list_evaluation_pipelines: READ,
  get_evaluation_pipeline: READ,
  create_evaluation_pipeline: WRITE,
  update_evaluation_pipeline: DESTRUCTIVE,

  // Account
  list_organizations: READ,
  switch_organization: WRITE,

  // Docs (separate /mcp/docs server)
  search_docs: READ_PUBLIC,
};

/**
 * Tools that cannot succeed against the current backend, so they are not
 * registered at all:
 * - run_evaluator: the run endpoint scores raw `inputs` only; the `log_ids`
 *   it sends are ignored.
 * - deploy_prompt_version: the backend refuses to deploy a draft, and no
 *   tool commits a prompt version first.
 */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "run_evaluator",
  "deploy_prompt_version",
]);

/**
 * Wraps `server.tool` so every tool registered afterwards carries its
 * annotations from TOOL_ANNOTATIONS, and hidden tools are skipped. A tool
 * missing from the table is treated as destructive, so a client asks before
 * running it; tests/tool-policy.test.ts fails until it is added.
 */
export function applyToolPolicy(server: McpServer): void {
  const originalTool = server.tool.bind(server);
  (server as any).tool = function (name: string) {
    if (HIDDEN_TOOLS.has(name)) return undefined;
    const registered = originalTool.apply(server, arguments as any);
    registered?.update({ annotations: TOOL_ANNOTATIONS[name] ?? DESTRUCTIVE });
    return registered;
  };
}
