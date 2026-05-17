import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient, rawFetch } from "../shared/client.js";

export function registerWorkflowTools(
  server: McpServer,
  client: AuthenticatedClient | null
) {
  server.tool(
    "list_workflows",
    "List all workflows (automations, monitors, evaluator pipelines) in your organization.",
    {
      page: z.number().optional().describe("Page number (default 1)."),
      page_size: z.number().optional().describe("Results per page."),
    },
    async ({ page, page_size }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.listWorkflows({
        Authorization: c.auth,
        ...(page ? { page } : {}),
        ...(page_size ? { page_size } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "filter_workflows",
    `Filter workflows by type and other fields.

Use the filters parameter to scope by type:
- { "type": { "value": ["automations"], "operator": "eq" } }
- { "type": { "value": ["monitors"], "operator": "eq" } }
- { "type": { "value": ["evaluators"], "operator": "eq" } }`,
    {
      filters: z.record(z.any()).describe('Filter object. Example: { "type": { "value": ["monitors"], "operator": "eq" } }'),
      page: z.number().optional().describe("Page number."),
      page_size: z.number().optional().describe("Results per page."),
      sort_by: z.string().optional().describe("Sort field. Prefix with - for descending."),
    },
    async ({ filters, page, page_size, sort_by }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.filterWorkflows({
        Authorization: c.auth,
        filters,
        ...(page ? { page } : {}),
        ...(page_size ? { page_size } : {}),
        ...(sort_by ? { sort_by } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "get_workflow",
    "Retrieve detailed information about a workflow including its task definitions.",
    {
      workflow_id: z.string().describe("Workflow ID."),
    },
    async ({ workflow_id }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.getWorkflow({
        Authorization: c.auth,
        workflow_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "create_workflow",
    `Create a new workflow. Workflows are event-driven pipelines with chained tasks.

TYPES:
- "monitors": Aggregation + threshold monitoring with notifications (default, visible on Monitors page)
- "automations": Triggered actions on log/trace events (Automations page)

TRIGGER EVENT TYPES:
- "request_log": Fires on every logged LLM request
- "trace_completed": Fires when a trace finishes
- "customer_budget_limit_reached": Fires on budget breach
- "on_eval_result_ingested": Fires when eval score is recorded
- "eval_only": No trigger, for evaluator pipelines used in experiments

TASK TYPES:
- condition: Filter/gate. Config: { condition_policy: { "event.<field>": { operator, value } }, on_true: "continue", on_false: "stop" }
  Field paths use namespace: event.cost, event.model, event.status, state.<task_id>.<field>
  Operators: "in" (categorical), "gte"/"lte"/"gt"/"lt" (numeric), "icontains"/"startswith" (text)
- aggregation: Time-window metrics. Config: { time_step_minutes: 5, metrics: [{ field_name: "event.cost", aggregation_function: "sum", output_field_name: "cost_sum" }] }
- notification: Alert. Config: { severity: "high", message_template: "Cost: $\{{state.agg.cost_sum}}" }
  Use {{variable}} for template variables.
- webhook: HTTP callback. Config: { webhook_url: "https://...", source: "event" }
- eval: Run evaluator. Config: { evaluator_id: "<uuid>" }
- ingest: Save to dataset. Config: { target_type: "dataset", target: { dataset_id: "<uuid>" } }
- sampling: Random filter. Config: { rate: 0.1 } (10% of events)
- compute: Arithmetic on upstream outputs. Config: { function: "ratio", inputs: [{ source: "state.<id>", field: "<field>" }] }
- switch: Multi-branch routing. Config: { cases: [{ condition_policy: {...}, target: "<task_id>" }], default: "<task_id>" }

TASK CHAINING: Each task needs "next" pointing to the next task's id. Without "next", the workflow stops.
Task ordering: gates (condition, sampling) → aggregation → actions (notification, webhook, eval, ingest).

EXAMPLE - Cost spike monitor:
{
  "name": "Cost spike monitor",
  "type": "monitors",
  "trigger_event_type": "request_log",
  "tasks": [
    { "id": "agg", "type": "aggregation", "label": "Cost sum (5m)", "next": "check",
      "config": { "time_step_minutes": 5, "metrics": [{ "field_name": "event.cost", "aggregation_function": "sum", "output_field_name": "cost_sum" }] } },
    { "id": "check", "type": "condition", "label": "Cost >= $1", "next": "notify",
      "config": { "on_true": "continue", "on_false": "stop", "condition_policy": { "state.agg.cost_sum": { "operator": "gte", "value": 1 } } } },
    { "id": "notify", "type": "notification", "label": "Cost alert",
      "config": { "severity": "high", "message_template": "Total cost in past 5 min: $\{{state.agg.cost_sum}} (threshold: $1.00)" } }
  ]
}`,
    {
      name: z.string().optional().describe("Workflow name."),
      description: z.string().optional().describe("Workflow description."),
      type: z
        .enum(["automations", "monitors", "evaluators"])
        .describe("Workflow type: automations, monitors, or evaluators."),
      trigger_event_type: z
        .enum([
          "request_log",
          "trace_completed",
          "customer_budget_limit_reached",
          "credit_low_balance_threshold_reached",
          "on_eval_result_ingested",
          "custom_event",
          "eval_only",
        ])
        .optional()
        .describe("Event that triggers the workflow."),
      tasks: z
        .array(
          z.object({
            id: z.string().describe("Unique task ID (used as target for 'next' pointers and state references)."),
            type: z.enum(["condition", "sampling", "eval", "ingest", "webhook", "notification", "aggregation", "switch", "compute"]).describe("Task type."),
            label: z.string().optional().describe("Human-readable task label."),
            next: z.string().optional().describe("ID of the next task. Without 'next', workflow STOPS after this task."),
            config: z.record(z.any()).describe("Task-specific configuration (see create_workflow description for details per type)."),
          }).passthrough()
        )
        .optional()
        .describe("Array of task definitions. Gates first (condition, sampling) → aggregation → actions (notification, webhook, eval, ingest)."),
      is_starred: z.boolean().optional().describe("Star/bookmark this workflow."),
    },
    async ({ name, description, type, trigger_event_type, tasks, is_starred }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.createWorkflow({
        Authorization: c.auth,
        type,
        ...(name ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(trigger_event_type ? { trigger_event_type } : {}),
        ...(tasks ? { tasks } : {}),
        ...(is_starred !== undefined ? { is_starred } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "update_workflow",
    "Update a workflow's configuration, tasks, or metadata.",
    {
      workflow_id: z.string().describe("Workflow ID."),
      name: z.string().optional().describe("Updated name."),
      description: z.string().optional().describe("Updated description."),
      type: z.enum(["automations", "monitors", "evaluators"]).optional().describe("Updated type."),
      trigger_event_type: z
        .enum([
          "request_log",
          "trace_completed",
          "customer_budget_limit_reached",
          "credit_low_balance_threshold_reached",
          "on_eval_result_ingested",
          "custom_event",
          "eval_only",
        ])
        .optional()
        .describe("Updated trigger event type."),
      tasks: z.array(z.record(z.any())).optional().describe("Updated task definitions."),
      is_starred: z.boolean().optional().describe("Star/unstar the workflow."),
    },
    async ({ workflow_id, name, description, type, trigger_event_type, tasks, is_starred }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.updateWorkflow({
        Authorization: c.auth,
        workflow_id,
        ...(name ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(type ? { type } : {}),
        ...(trigger_event_type !== undefined ? { trigger_event_type } : {}),
        ...(tasks ? { tasks } : {}),
        ...(is_starred !== undefined ? { is_starred } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "list_workflow_versions",
    "List all versions of a workflow.",
    {
      workflow_id: z.string().describe("Workflow ID."),
      page: z.number().optional().describe("Page number."),
      page_size: z.number().optional().describe("Results per page."),
    },
    async ({ workflow_id, page, page_size }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.listWorkflowVersions({
        Authorization: c.auth,
        workflow_id,
        ...(page ? { page } : {}),
        ...(page_size ? { page_size } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "get_workflow_version",
    "Retrieve a specific version of a workflow.",
    {
      workflow_id: z.string().describe("Workflow ID."),
      version: z.number().describe("Version number."),
    },
    async ({ workflow_id, version }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.getWorkflowVersion({
        Authorization: c.auth,
        workflow_id,
        version,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "commit_workflow",
    `Commit the current draft of a workflow/pipeline, locking it as a read-only version that can be deployed.

REQUIRED before deploy_workflow. The deploy endpoint rejects calls if no committed version exists.
Calls POST /api/workflows/{id}/commits/ (the correct platform endpoint — different from the SDK's createWorkflowVersion which doesn't actually commit).

Flow:
1. create_workflow (or create_evaluation_pipeline) — creates a draft
2. commit_workflow — locks current draft as read-only
3. deploy_workflow — makes the committed version live

Applies to evaluator pipelines too (pipelines = workflows of type=evaluators).`,
    {
      workflow_id: z.string().describe("Workflow/pipeline family workflow_id."),
      description: z.string().optional().describe("Commit message / version description."),
    },
    async ({ workflow_id, description }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, `/api/workflows/${workflow_id}/commits/`, {
        method: "POST",
        body: description ? { description } : {},
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "deploy_workflow",
    `Deploy a committed workflow/pipeline version as the active (live) version.

Calls POST /api/workflows/{id}/deployments/ (the correct platform endpoint — different from the SDK's deployWorkflow).
If version is omitted, deploys the latest committed version.

REQUIREMENT: must call commit_workflow first. If no committed version exists, deploy returns 404 "Committed version not found".`,
    {
      workflow_id: z.string().describe("Workflow/pipeline family workflow_id."),
      version: z.number().optional().describe("Specific version number to deploy. Omit for latest committed."),
    },
    async ({ workflow_id, version }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, `/api/workflows/${workflow_id}/deployments/`, {
        method: "POST",
        body: version !== undefined ? { version } : {},
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "undeploy_workflow",
    "Undeploy a workflow, stopping it from processing events.",
    {
      workflow_id: z.string().describe("Workflow ID."),
    },
    async ({ workflow_id }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.undeployWorkflow({
        Authorization: c.auth,
        workflow_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "validate_workflow",
    "Validate a workflow by running it against a sample log. Returns validation results and any errors.",
    {
      workflow_id: z.string().describe("Workflow ID."),
      log_id: z.string().optional().describe("Specific log ID to validate against. If omitted, uses the most recent log."),
    },
    async ({ workflow_id, log_id }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.validateWorkflow({
        Authorization: c.auth,
        workflow_id,
        ...(log_id ? { log_id } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
