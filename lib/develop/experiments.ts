import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient } from "../shared/client.js";

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
    `Create and run an experiment. Processes a dataset through workflows and scores results with evaluators.

REQUIRED: name, dataset_id.

WORKFLOW TYPES:
- "completion": Run a model completion. Config: { model, temperature, max_tokens, top_p, ... }
- "prompt": Use a saved prompt. Config: { prompt_id, version (optional) }
- "custom": User-defined logic with manual submission. Set allow_submission=true, timeout_hours for deadline.

EVALUATOR SLUGS:
Pass evaluator slugs (from list_evaluators) to auto-run scoring on results.

EXAMPLE - Compare two models:
{
  "name": "GPT-4o vs Claude comparison",
  "dataset_id": "ds_abc123",
  "workflows": [
    { "type": "completion", "config": { "model": "gpt-4o", "temperature": 0 } },
    { "type": "completion", "config": { "model": "claude-sonnet-4-20250514", "temperature": 0 } }
  ],
  "evaluator_slugs": ["response-quality", "hallucination-check"]
}

EXAMPLE - Test a prompt version:
{
  "name": "Prompt v3 test",
  "dataset_id": "ds_abc123",
  "workflows": [
    { "type": "prompt", "config": { "prompt_id": "prompt_xyz" } }
  ],
  "evaluator_slugs": ["accuracy"]
}`,
    {
      name: z.string().describe("Experiment name"),
      dataset_id: z.string().describe("Dataset ID to run the experiment against"),
      description: z.string().optional().describe("Experiment description"),
      workflows: z
        .array(
          z.object({
            type: z
              .enum(["custom", "completion", "prompt"])
              .describe("Workflow type: completion (model), prompt (saved prompt), or custom (manual submission)"),
            config: z
              .object({
                model: z.string().optional().describe("Model for completion workflows (e.g. 'gpt-4o')"),
                temperature: z.number().optional().describe("Sampling temperature"),
                max_tokens: z.number().optional().describe("Max tokens to generate"),
                top_p: z.number().optional().describe("Nucleus sampling"),
                frequency_penalty: z.number().optional(),
                presence_penalty: z.number().optional(),
                stop: z.array(z.string()).optional().describe("Stop sequences"),
                response_format: z.record(z.any()).optional().describe("Response format config"),
                tools: z.array(z.any()).optional().describe("Tools for function calling"),
                tool_choice: z.any().optional().describe("Tool choice setting"),
                reasoning_effort: z.string().optional().describe("Reasoning effort: low, medium, high"),
                prompt_id: z.string().optional().describe("Prompt ID for prompt workflows"),
              })
              .optional()
              .describe("Workflow-specific config. completion: model settings. prompt: prompt_id."),
            allow_submission: z
              .boolean()
              .optional()
              .describe("Allow manual result submission (for custom workflows)"),
            timeout_hours: z
              .number()
              .optional()
              .describe("Timeout in hours for custom workflows"),
          })
        )
        .optional()
        .describe("Array of workflow definitions to execute in the experiment"),
      evaluator_slugs: z
        .array(z.string())
        .optional()
        .describe("Array of evaluator slugs to auto-run on experiment results (from list_evaluators)"),
    },
    async ({ name, dataset_id, description, workflows, evaluator_slugs }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.createExperiment({
        Authorization: c.auth,
        name,
        dataset_id,
        ...(description !== undefined ? { description } : {}),
        ...(workflows !== undefined ? { workflows } : {}),
        ...(evaluator_slugs !== undefined ? { evaluator_slugs } : {}),
      });
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
    "update_experiment_span",
    "Update a specific span in an experiment (e.g., submit custom workflow results).",
    {
      experiment_id: z
        .string()
        .describe("Unique experiment identifier (from list_experiments)"),
      log_id: z
        .string()
        .describe("Unique span/log identifier (from list_experiment_spans)"),
      body: z
        .record(z.any())
        .describe(
          "Object containing the fields to update on the span (e.g. output, metadata, status)"
        ),
    },
    async ({ experiment_id, log_id, body }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.updateExperimentSpan({
        Authorization: c.auth,
        experiment_id,
        log_id,
        body,
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
    "export_experiment_spans",
    "Export experiment spans with pagination and filtering. Useful for analyzing results outside the platform.",
    {
      experiment_id: z.string().describe("Unique experiment identifier (from list_experiments)"),
      export: z.string().describe('Set to "1" or "true" to trigger export.'),
      page: z.number().describe("Page number (default: 1)."),
      page_size: z.number().describe("Number of results per page (default: 100)."),
      sort_by: z.string().describe('Sort field (e.g. "-cost", "-start_time", "name").'),
      start_time: z.string().describe("Filter start time (ISO 8601 format)."),
      end_time: z.string().describe("Filter end time (ISO 8601 format)."),
    },
    async ({ experiment_id, export: exportParam, page, page_size, sort_by, start_time, end_time }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.exportExperimentSpans({
        Authorization: c.auth,
        experiment_id,
        export: exportParam,
        page,
        page_size,
        sort_by,
        start_time,
        end_time,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "get_experiment_spans_summary",
    "Get aggregated summary statistics for experiment spans within a time range.",
    {
      experiment_id: z
        .string()
        .describe("Unique experiment identifier (from list_experiments)"),
      start_time: z
        .string()
        .describe("Start of the time range in ISO 8601 format (e.g. 2024-01-01T00:00:00Z)"),
      end_time: z
        .string()
        .describe("End of the time range in ISO 8601 format (e.g. 2024-12-31T23:59:59Z)"),
    },
    async ({ experiment_id, start_time, end_time }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.getExperimentSpansSummary({
        Authorization: c.auth,
        experiment_id,
        start_time,
        end_time,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
