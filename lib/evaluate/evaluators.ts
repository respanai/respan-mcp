import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthenticatedClient } from '../shared/client.js';
import { requireClient, rawFetch } from '../shared/client.js';

export function registerEvaluatorTools(server: McpServer, client: AuthenticatedClient | null) {
  server.tool(
    'list_evaluators',
    'List all evaluators in your organization with pagination.',
    {
      page_size: z.number().optional().describe('Number of evaluators to return per page.'),
      page: z.number().optional().describe('Page number for pagination.'),
    },
    async ({ page_size, page }) => {
      const c = requireClient(client);
      const data = await c.client.evaluators.listEvaluators({
        Authorization: c.auth,
        ...(page_size ? { page_size } : {}),
        ...(page ? { page } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'get_evaluator',
    'Retrieve detailed information about a specific evaluator including its config.',
    {
      evaluator_id: z.string().describe('The unique identifier of the evaluator to retrieve.'),
    },
    async ({ evaluator_id }) => {
      const c = requireClient(client);
      const data = await c.client.evaluators.retrieveEvaluator({ Authorization: c.auth, evaluator_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'create_evaluator',
    `Create a new evaluator (grader). Evaluators score LLM outputs.

REQUIRED: name, type, score_value_type.

TYPES:
- "llm": LLM-based evaluation. Requires llm_config with model + evaluator_definition.
- "code": Code-based evaluation. Requires code_config with eval_code_snippet.
- "human": Manual human evaluation. No automation config needed.

SCORE VALUE TYPES: numerical, boolean, percentage, single_select, multi_select, json, text

FOR LLM EVALUATORS:
llm_config must include:
- model (required): e.g. "gpt-4o-mini"
- evaluator_definition (required): Jinja2 prompt template. MUST contain {{output}}.
  Use {{input}} for user question, {{expected_output}} for ground truth.
- scoring_rubric (recommended): Scoring instructions appended after definition.
- temperature, max_tokens, top_p, etc. (optional)

EXAMPLE - Boolean LLM grader:
{
  "name": "Hallucination Check",
  "type": "llm",
  "score_value_type": "boolean",
  "llm_config": {
    "model": "gpt-4o-mini",
    "evaluator_definition": "Score whether this output hallucinates.\\nInput: {{input}}\\nOutput: {{output}}\\nReturn true or false.",
    "temperature": 0
  }
}

EXAMPLE - Numerical LLM grader with rubric:
{
  "name": "Response Quality",
  "type": "llm",
  "score_value_type": "numerical",
  "score_config": { "min_score": 1, "max_score": 5 },
  "passing_conditions": { "primary_score": { "operator": "gte", "value": 3 } },
  "llm_config": {
    "model": "gpt-4o",
    "evaluator_definition": "Evaluate the quality of this response.\\nInput: {{input}}\\nOutput: {{output}}",
    "scoring_rubric": "1=terrible, 2=poor, 3=ok, 4=good, 5=excellent"
  }
}`,
    {
      name: z.string().describe('Evaluator name.'),
      type: z
        .enum(['llm', 'code', 'human'])
        .describe('Evaluator type: llm (requires llm_config), code (requires code_config), or human.'),
      score_value_type: z
        .enum(['numerical', 'boolean', 'percentage', 'single_select', 'multi_select', 'json', 'text'])
        .describe('Score format: numerical, boolean, percentage, single_select, multi_select, json, text.'),
      evaluator_slug: z.string().optional().describe('Unique slug identifier. Auto-generated if not provided.'),
      description: z.string().optional().describe('Evaluator description.'),
      score_config: z
        .object({
          min_score: z.number().optional().describe('Minimum score (for numerical/percentage).'),
          max_score: z.number().optional().describe('Maximum score (for numerical/percentage).'),
          choices: z
            .array(z.object({ name: z.string(), value: z.string() }))
            .optional()
            .describe('Choices for single_select/multi_select types.'),
        })
        .optional()
        .describe('Score type configuration.'),
      passing_conditions: z
        .record(z.any())
        .optional()
        .describe('Conditions for passing. Example: { "primary_score": { "operator": "gte", "value": 3 } }'),
      llm_config: z
        .object({
          model: z.string().optional().describe('LLM model to use (e.g. "gpt-4o-mini").'),
          evaluator_definition: z
            .string()
            .optional()
            .describe('Evaluation prompt template. MUST contain {{output}}. Use {{input}} and {{expected_output}} as needed.'),
          scoring_rubric: z.string().optional().describe('Scoring criteria instructions.'),
          temperature: z.number().optional().describe('Sampling temperature.'),
          max_tokens: z.number().optional().describe('Max tokens for LLM response.'),
          top_p: z.number().optional(),
          frequency_penalty: z.number().optional(),
          presence_penalty: z.number().optional(),
        })
        .optional()
        .describe('LLM automation config. Required for type="llm". Must include model + evaluator_definition.'),
      code_config: z
        .object({
          eval_code_snippet: z
            .string()
            .optional()
            .describe('Python code with main(eval_inputs) function returning the score.'),
        })
        .optional()
        .describe('Code automation config. Required for type="code".'),
      categorical_choices: z
        .array(z.object({ name: z.string().optional(), value: z.any().optional() }))
        .optional()
        .describe('Choices for single_select/multi_select score types.'),
    },
    async (params) => {
      const c = requireClient(client);
      const { name, type, score_value_type, evaluator_slug, description, score_config, passing_conditions, llm_config, code_config, categorical_choices } = params;

      if (type === 'llm') {
        if (!llm_config) {
          throw new Error('LLM evaluators require llm_config. Include at minimum: { "model": "gpt-4o-mini", "evaluator_definition": "<prompt with {{output}}>" }');
        }
        const def = llm_config.evaluator_definition;
        if (!def) {
          throw new Error('LLM evaluators require evaluator_definition in llm_config — the prompt template the LLM uses to score. Must contain {{output}}.');
        }
        if (!def.includes('{{output}}')) {
          throw new Error('evaluator_definition MUST contain the {{output}} template variable. Without it, the evaluator cannot see the output it is supposed to score.');
        }
        if (!llm_config.model) {
          throw new Error('LLM evaluators require llm_config.model (e.g. "gpt-4o-mini").');
        }
      }
      if (type === 'code') {
        if (!code_config || !code_config.eval_code_snippet) {
          throw new Error('Code evaluators require code_config with eval_code_snippet. Include: { "eval_code_snippet": "def main(eval_inputs): ..." }');
        }
      }

      const data = await c.client.evaluators.createEvaluator({
        Authorization: c.auth,
        name,
        type,
        score_value_type,
        ...(evaluator_slug ? { evaluator_slug } : {}),
        ...(description ? { description } : {}),
        ...(score_config ? { score_config } : {}),
        ...(passing_conditions ? { passing_conditions } : {}),
        ...(llm_config ? { llm_config } : {}),
        ...(code_config ? { code_config } : {}),
        ...(categorical_choices ? { categorical_choices } : {}),
      });
      const result = data as Record<string, unknown>;
      const id = result?.id ?? result?.evaluator_id;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...result,
            _next_steps: `Created as draft. To use in production: 1) test_evaluator with sample inputs to verify, 2) commit_evaluator to lock the version, 3) create_evaluation_pipeline to make it show on the Evaluators page.`,
            _evaluator_id: id,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'test_evaluator',
    `Test-run a grader with sample inputs to verify it scores correctly BEFORE committing.

Required keys in inputs: at least "input" and "output". Optional: "expected_output", "metrics", "metadata".

Example:
{
  "evaluator_id": "abc123",
  "inputs": { "input": "What is 2+2?", "output": "4", "expected_output": "4" }
}

Returns the actual score (boolean_value / numerical_value / etc.) and reasoning. Use this before commit_evaluator.`,
    {
      evaluator_id: z.string().describe('Evaluator ID (optionally with version: "id:version").'),
      inputs: z.record(z.any()).describe('Sample data. At minimum {input, output}. Add expected_output / metrics / metadata as the evaluator needs.'),
      generation_method: z.enum(['auto', 'llm', 'code']).optional().describe('Force evaluation method. Default: auto.'),
    },
    async ({ evaluator_id, inputs, generation_method }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, `/api/evaluators/${evaluator_id}/run/`, {
        method: 'POST',
        body: {
          inputs,
          ...(generation_method ? { generation_method } : {}),
        },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'commit_evaluator',
    `Commit the current draft of a grader, creating a new read-only version.

IMPORTANT: Only commit AFTER a successful test_evaluator run. After committing, use create_evaluation_pipeline to wrap the grader in a V2 pipeline that renders in the UI.`,
    {
      evaluator_id: z.string().describe('Evaluator ID to commit.'),
      version_description: z.string().optional().describe('Commit message describing what changed in this version.'),
    },
    async ({ evaluator_id, version_description }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, `/api/evaluators/${evaluator_id}/versions/`, {
        method: 'POST',
        body: version_description ? { version_description } : {},
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'list_evaluator_versions',
    'List all versions (commits) of an evaluator.',
    {
      evaluator_id: z.string().describe('Evaluator ID.'),
      page: z.number().optional().describe('Page number.'),
      page_size: z.number().optional().describe('Results per page.'),
    },
    async ({ evaluator_id, page, page_size }) => {
      const c = requireClient(client);
      const q = new URLSearchParams();
      if (page !== undefined) q.set('page', String(page));
      if (page_size !== undefined) q.set('page_size', String(page_size));
      const qs = q.toString();
      const path = `/api/evaluators/${evaluator_id}/versions/${qs ? `?${qs}` : ''}`;
      const data = await rawFetch(c, path, { method: 'GET' });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'update_evaluator',
    "Update an existing evaluator's configuration.",
    {
      evaluator_id: z.string().describe('The unique identifier of the evaluator to update.'),
      name: z.string().optional().describe('Updated name.'),
      description: z.string().optional().describe('Updated description.'),
      score_config: z.record(z.any()).optional().describe('Updated score configuration.'),
      passing_conditions: z.record(z.any()).optional().describe('Updated passing conditions.'),
      llm_config: z.record(z.any()).optional().describe('Updated LLM config (model, evaluator_definition, scoring_rubric, temperature, etc.).'),
      code_config: z.record(z.any()).optional().describe('Updated code config (eval_code_snippet).'),
    },
    async ({ evaluator_id, name, description, score_config, passing_conditions, llm_config, code_config }) => {
      const c = requireClient(client);
      const data = await c.client.evaluators.updateEvaluator({
        Authorization: c.auth,
        evaluator_id,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(score_config !== undefined ? { score_config } : {}),
        ...(passing_conditions !== undefined ? { passing_conditions } : {}),
        ...(llm_config !== undefined ? { llm_config } : {}),
        ...(code_config !== undefined ? { code_config } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'delete_evaluator',
    'Permanently delete an evaluator. This action cannot be undone.',
    {
      evaluator_id: z.string().describe('The unique identifier of the evaluator to delete.'),
    },
    async ({ evaluator_id }) => {
      const c = requireClient(client);
      await c.client.evaluators.deleteEvaluator({ Authorization: c.auth, evaluator_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, evaluator_id }, null, 2) }],
      };
    },
  );

  server.tool(
    'run_evaluator',
    `Run an evaluator on a single log/span to verify it works.

This is for quick verification of one record (e.g. confirm an evaluator scores as expected before running broader experiments).
For scoring many records, create an experiment instead.

Returns the actual score (boolean_value / numerical_value / etc.) and cost.`,
    {
      evaluator_id: z.string().describe('The unique identifier of the evaluator to run.'),
      log_id: z.string().describe('The span/log unique ID to score (from list_experiment_spans, list_traces, etc.).'),
    },
    async ({ evaluator_id, log_id }) => {
      const c = requireClient(client);
      const data = await c.client.evaluators.runEvaluator({
        Authorization: c.auth,
        evaluator_id,
        log_ids: [log_id],
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
