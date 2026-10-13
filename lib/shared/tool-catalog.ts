import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Shared discovery metadata; names and schemas remain those of registered tools. */
export const TOOL_CATEGORY_META_KEY = 'respan/category';

export const TOOL_CATEGORIES = [
  'workspace', 'traces', 'logs', 'conversations', 'metrics', 'behaviors',
  'errors', 'monitors', 'prompts', 'custom-behaviors', 'automations',
  'exports', 'workflows', 'datasets', 'graders', 'evaluators', 'experiments', 'docs',
] as const;
export type ToolCategory = typeof TOOL_CATEGORIES[number];

export function toolCategory(name: string): ToolCategory {
  if (name.startsWith('custom_behavior_')) return 'custom-behaviors';
  if (name.startsWith('behavior_') || name === 'pulse_behaviors_summary') return 'behaviors';
  if (name.startsWith('pulse_error_') || name === 'pulse_incidents_list') return 'errors';
  if (name.startsWith('dashboard_') || name.startsWith('end_user_')) return 'metrics';
  if (name.startsWith('export_workflow_')) return 'exports';
  const prefixes: Record<string, ToolCategory> = {
    org: 'workspace', trace: 'traces', log: 'logs', thread: 'conversations',
    monitor: 'monitors', prompt: 'prompts', automation: 'automations',
    workflow: 'workflows', dataset: 'datasets', grader: 'graders',
    evaluator: 'evaluators', experiment: 'experiments', docs: 'docs',
  };
  const category = prefixes[name.split('_')[0]];
  if (!category) throw new Error(`Tool '${name}' has no discovery category.`);
  return category;
}

/** Attach category metadata on every transport without changing schemas or hints. */
export function applyToolCatalog(server: McpServer): void {
  for (const method of ['tool', 'registerTool'] as const) {
    const original = server[method].bind(server);
    (server as any)[method] = function (name: string, ...args: unknown[]) {
      const registered = (original as any)(name, ...args);
      registered?.update({ _meta: {
        ...registered._meta,
        [TOOL_CATEGORY_META_KEY]: toolCategory(name),
      } });
      return registered;
    };
  }
}
