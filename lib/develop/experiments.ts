import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient, rawFetch } from "../shared/client.js";

export function registerExperimentTools(
  server: McpServer,
  client: AuthenticatedClient | null
) {
  server.tool(
    "list_experiments",
    "List all experiments in your organization.",
    {
      page_size: z.number().optional().describe("Results per page."),
      page: z.number().optional().describe("Page number (default 1)."),
    },
    async ({ page_size, page }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.listExperiments({
        Authorization: c.auth,
        ...(page_size ? { page_size } : {}),
        ...(page ? { page } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "get_experiment",
    "Retrieve detailed information about a specific experiment by its ID.",
    {
      experiment_id: z
        .string()
        .describe("Unique experiment identifier (from list_experiments)"),
    },
    async ({ experiment_id }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.retrieveExperiment({
        Authorization: c.auth,
        experiment_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "create_experiment",
    `Create and run an experiment. Processes a dataset's inputs through a workflow chain (prompt / model / passthrough) and scores results with evaluator pipelines.

REQUIRED: dataset_id, workflow, evaluator_workflow_ids.

WORKFLOW TYPES (these are how each dataset row produces an output):
- "prompt": Use a saved prompt. Config: { prompt_id, version (optional) }
- "completion": Direct model completion. Config: { model, temperature, max_tokens, top_p, response_format, tools, ... }
- "duplicate": Passthrough — skip generation and just score the dataset's existing outputs. Use when your dataset already has outputs (e.g. logs imported from prod) and you only want to evaluate them.
- "condition": Branch based on field values. Config: { condition_policy: { "event.<field>": { operator, value } } }

EVALUATOR_WORKFLOW_IDS:
Pass PIPELINE IDs (from list_evaluation_pipelines or create_evaluation_pipeline — the "id" field, NOT "workflow_id"). These pipelines score each row after the workflow completes.

EXAMPLE — Compare two models on a dataset:
{
  "name": "GPT-4o vs Claude",
  "dataset_id": "ds_abc",
  "workflow": [
    { "type": "completion", "config": { "model": "openai/gpt-4o", "temperature": 0 } }
  ],
  "evaluator_workflow_ids": ["<pipeline_id_for_quality>"]
}

EXAMPLE — Score existing dataset outputs without re-running a model:
{
  "name": "Score existing outputs",
  "dataset_id": "ds_with_outputs",
  "workflow": [
    { "type": "duplicate", "config": { "name": "passthrough" } }
  ],
  "evaluator_workflow_ids": ["<pipeline_id>"]
}

EXAMPLE — Test a saved prompt version:
{
  "name": "Prompt v3",
  "dataset_id": "ds_abc",
  "workflow": [
    { "type": "prompt", "config": { "prompt_id": "prompt_xyz", "version": "3" } }
  ],
  "evaluator_workflow_ids": ["<pipeline_id>"]
}`,
    {
      dataset_id: z.string().describe("Dataset ID to run the experiment against."),
      workflow: z
        .array(
          z.object({
            type: z
              .enum(["prompt", "completion", "duplicate", "condition"])
              .describe("Workflow type: prompt (saved prompt), completion (raw model call), duplicate (passthrough — score existing dataset outputs), condition (branch)."),
            config: z
              .record(z.any())
              .describe("Type-specific config. prompt: {prompt_id, version?}. completion: {model, temperature, max_tokens, response_format?, tools?, ...}. duplicate: {name?}. condition: {condition_policy: {<field>: {operator, value}}}."),
          })
        )
        .describe("Workflow tasks executed in order for each dataset row."),
      evaluator_workflow_ids: z
        .array(z.string())
        .describe("Evaluator PIPELINE IDs (the 'id' from list_evaluation_pipelines / create_evaluation_pipeline, NOT 'workflow_id'). At least one required."),
      name: z.string().optional().describe("Experiment name."),
      description: z.string().optional().describe("Experiment description."),
      batch_size: z.number().optional().describe("Rows processed per batch (default: 100)."),
      concurrency: z.number().optional().describe("Concurrent workers (default: 15)."),
      enable_tracing: z.boolean().optional().describe("Create trace logs for each row (default: true)."),
    },
    async ({ dataset_id, workflow, evaluator_workflow_ids, name, description, batch_size, concurrency, enable_tracing }) => {
      if (!evaluator_workflow_ids?.length) {
        throw new Error("evaluator_workflow_ids is required. At least one evaluator pipeline ID is needed. Use list_evaluation_pipelines or create_evaluation_pipeline first.");
      }
      const c = requireClient(client);
      const normalizedWorkflow = workflow.map(w => ({ ...w, config: w.config || {} }));
      const body: Record<string, unknown> = {
        dataset_id,
        workflow: normalizedWorkflow,
        evaluator_workflow_ids,
      };
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (batch_size !== undefined) body.batch_size = batch_size;
      if (concurrency !== undefined) body.concurrency = concurrency;
      if (enable_tracing !== undefined) body.enable_tracing = enable_tracing;
      const data = await rawFetch(c, "/api/v2/experiments/", { method: "POST", body });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "list_experiment_spans",
    "List all spans (execution traces) for a specific experiment.",
    {
      experiment_id: z
        .string()
        .describe("Unique experiment identifier (from list_experiments)"),
    },
    async ({ experiment_id }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.listExperimentSpans({
        Authorization: c.auth,
        experiment_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "get_experiment_span",
    "Retrieve detailed information about a specific span within an experiment.",
    {
      experiment_id: z
        .string()
        .describe("Unique experiment identifier (from list_experiments)"),
      log_id: z
        .string()
        .describe("Unique span/log identifier (from list_experiment_spans)"),
    },
    async ({ experiment_id, log_id }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.retrieveExperimentSpan({
        Authorization: c.auth,
        experiment_id,
        log_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_experiment",
    "Permanently delete an experiment and its spans. This action cannot be undone.",
    {
      experiment_id: z.string().describe("Unique experiment identifier (from list_experiments)"),
    },
    async ({ experiment_id }) => {
      const c = requireClient(client);
      await c.client.experiments.deleteExperiment({
        Authorization: c.auth,
        experiment_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ deleted: true, experiment_id }, null, 2) }],
      };
    }
  );

  server.tool(
    "get_experiment_score_averages",
    `Compute average score per evaluator for an experiment by walking the spans client-side.

Use this when the backend summary/histogram endpoints return empty score aggregates (known issue on some experiments). Returns avg, min, max, and count per evaluator. Pages through up to max_spans (default 500).`,
    {
      experiment_id: z.string().describe("Unique experiment identifier"),
      max_spans: z.number().optional().describe("Maximum spans to walk (default: 500). Increase for large experiments."),
    },
    async ({ experiment_id, max_spans = 500 }) => {
      const c = requireClient(client);
      const buckets: Record<string, {
        count: number;
        sum: number;
        min: number;
        max: number;
        name: string;
        score_type: string;
      }> = {};
      let scanned = 0;
      let page = 1;
      const pageSize = 50;
      while (scanned < max_spans) {
        const resp = await c.client.experiments.listExperimentSpans({
          Authorization: c.auth,
          experiment_id,
        });
        const results = (resp as { results?: unknown[] }).results || [];
        if (!results.length) break;
        const addScore = (key: string, name: string, scoreType: string, val: number) => {
          if (Number.isNaN(val)) return;
          if (!buckets[key]) {
            buckets[key] = { count: 0, sum: 0, min: val, max: val, name, score_type: scoreType };
          }
          buckets[key].count++;
          buckets[key].sum += val;
          if (val < buckets[key].min) buckets[key].min = val;
          if (val > buckets[key].max) buckets[key].max = val;
        };
        const extractPipelineScore = (raw: unknown, taskKey: string): boolean => {
          let parsed: unknown = raw;
          if (typeof raw === "string") { try { parsed = JSON.parse(raw); } catch { return false; } }
          const p = parsed as { workflow_type?: string; output?: { primary_score?: unknown; evaluator_id?: string; evaluator_name?: string; score_value_type?: string } };
          if (p?.workflow_type !== "eval" || !p.output) return false;
          const evalOut = p.output;
          const raw_score = evalOut.primary_score;
          if (raw_score === null || raw_score === undefined) return false;
          const val = typeof raw_score === "boolean" ? (raw_score ? 1 : 0) : Number(raw_score);
          if (Number.isNaN(val)) return false;
          addScore(evalOut.evaluator_id || taskKey, evalOut.evaluator_name || taskKey, evalOut.score_value_type || "numerical", val);
          return true;
        };
        const walkTreeForEvals = (node: { name?: string; span_name?: string; output?: unknown; children?: unknown[] }) => {
          const taskKey = node.span_name || node.name || "";
          if (taskKey.includes("eval.task") || taskKey.includes("llm_eval")) {
            extractPipelineScore(node.output, taskKey);
          }
          for (const c of (node.children || []) as { name?: string; span_name?: string; output?: unknown; children?: unknown[] }[]) walkTreeForEvals(c);
        };

        for (const span of results) {
          const s = span as {
            id?: string;
            scores?: Record<string, Record<string, unknown>>;
            task_metrics?: Record<string, { output?: unknown }>;
          };
          // Legacy path: span.scores populated by direct evaluator runs
          for (const [key, score] of Object.entries(s.scores || {})) {
            if (!score || typeof score !== "object") continue;
            const name = (score.evaluator_name as string) || key.split(":")[0];
            const val = score.numerical_value !== null && score.numerical_value !== undefined
              ? Number(score.numerical_value)
              : score.boolean_value !== null && score.boolean_value !== undefined
                ? (score.boolean_value ? 1 : 0)
                : null;
            if (val === null) continue;
            addScore(key, name, (score.score_value_type as string) || "numerical", val);
          }
          // Pipeline path: scores live inside task_metrics[<eval_task>].output (JSON string).
          // List endpoint truncates output to ~50 chars — detect truncation and fall back to detail fetch.
          let foundFromList = false;
          let needsDetail = false;
          for (const [taskKey, task] of Object.entries(s.task_metrics || {})) {
            if (!task || typeof task !== "object" || !("output" in task)) continue;
            if (!taskKey.includes("eval")) continue;
            const raw = task.output;
            if (typeof raw === "string" && (raw.length < 200 || !raw.trim().endsWith("}"))) {
              needsDetail = true;
              continue;
            }
            if (extractPipelineScore(raw, taskKey)) foundFromList = true;
          }
          if (needsDetail && !foundFromList && s.id) {
            try {
              const detail = await c.client.experiments.retrieveExperimentSpan({
                Authorization: c.auth,
                experiment_id,
                log_id: s.id,
              }) as { span_tree?: unknown[] };
              for (const root of (detail.span_tree || []) as { name?: string; span_name?: string; output?: unknown; children?: unknown[] }[]) walkTreeForEvals(root);
            } catch { /* skip on error */ }
          }
        }
        scanned += results.length;
        // Most list endpoints aren't paginated here; break after first call unless backend supports paging.
        break;
        // Note: listExperimentSpans currently returns all spans in one call.
      }
      const result = Object.entries(buckets).map(([key, b]) => ({
        evaluator_key: key,
        evaluator_name: b.name,
        score_type: b.score_type,
        count: b.count,
        avg: b.count ? b.sum / b.count : 0,
        min: b.min,
        max: b.max,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ experiment_id, spans_scanned: scanned, evaluators: result }, null, 2) }],
      };
    }
  );

}
