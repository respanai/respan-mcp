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
  create_monitor_workflow: "monitor_create",
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
