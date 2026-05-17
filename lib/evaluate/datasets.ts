import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthenticatedClient } from '../shared/client.js';
import { requireClient } from '../shared/client.js';

export function registerDatasetTools(server: McpServer, client: AuthenticatedClient | null) {
  server.tool(
    'list_datasets',
    'List all datasets in your organization.',
    {
      page_size: z.number().optional().describe('Number of datasets to return per page (max 100). Defaults to 50.'),
      page: z.number().optional().describe('Page number for pagination.'),
    },
    async ({ page_size = 50, page = 1 }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.listDatasets({ Authorization: c.auth, page_size, page });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'get_dataset',
    'Retrieve detailed information about a specific dataset.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset to retrieve.'),
    },
    async ({ dataset_id }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.retrieveDataset({ Authorization: c.auth, dataset_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'create_dataset',
    `Create a new dataset.

MODES:
- Empty dataset: pass is_empty=true. No time range needed.
- Sampled from logs: pass start_time, end_time, and optionally sampling (1-100) and initial_log_filters.
- Duplicate existing: pass source_dataset_id to copy logs from another dataset.`,
    {
      name: z.string().optional().describe('Dataset name. Required unless source_dataset_id is provided.'),
      description: z.string().optional().describe('A description of the dataset.'),
      is_empty: z.boolean().optional().describe('Create an empty dataset without importing logs (skips time range requirement).'),
      sampling: z.number().optional().describe('Percent of matching logs to add (1-100).'),
      start_time: z.string().optional().describe('ISO 8601 start of log time range. Required when sampling logs.'),
      end_time: z.string().optional().describe('ISO 8601 end of log time range. Required when sampling logs.'),
      initial_log_filters: z
        .record(z.object({
          operator: z.string().optional(),
          value: z.any().optional(),
        }))
        .optional()
        .describe('Filters keyed by field name. Example: { "status_code": { "operator": "eq", "value": 200 } }'),
      source_dataset_id: z.string().optional().describe('Existing dataset ID to duplicate. Copies logs asynchronously.'),
    },
    async ({ name, description, is_empty, sampling, start_time, end_time, initial_log_filters, source_dataset_id }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.createDataset({
        Authorization: c.auth,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(is_empty !== undefined ? { is_empty } : {}),
        ...(sampling !== undefined ? { sampling } : {}),
        ...(start_time !== undefined ? { start_time } : {}),
        ...(end_time !== undefined ? { end_time } : {}),
        ...(initial_log_filters !== undefined ? { initial_log_filters } : {}),
        ...(source_dataset_id !== undefined ? { source_dataset_id } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'update_dataset',
    "Update a dataset's name and/or description.",
    {
      dataset_id: z.string().describe('The unique identifier of the dataset to update.'),
      name: z.string().optional().describe('Updated name for the dataset.'),
      description: z.string().optional().describe('Updated description for the dataset.'),
    },
    async ({ dataset_id, name, description }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.updateDataset({
        Authorization: c.auth,
        dataset_id,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'list_dataset_logs',
    'List all logs (data points) in a dataset with pagination and filtering.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      page: z.number().optional().describe('Page number (default 1).'),
      page_size: z.number().optional().describe('Results per page (max 100).'),
      sort_by: z.string().optional().describe('Sort field. Prefix with - for descending.'),
      include_fields: z.string().optional().describe('Comma-separated list of fields to include in response.'),
      filters: z
        .record(z.object({
          operator: z.string().optional().describe('Filter operator (e.g. "eq", "icontains", "gt")'),
          value: z.any().optional().describe('Filter value'),
        }))
        .optional()
        .describe('Filters keyed by field name. Example: { "status_code": { "operator": "eq", "value": 200 } }'),
    },
    async ({ dataset_id, page, page_size, sort_by, include_fields, filters }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.listDatasetLogs({
        Authorization: c.auth,
        dataset_id,
        ...(page ? { page } : {}),
        ...(page_size ? { page_size } : {}),
        ...(sort_by ? { sort_by } : {}),
        ...(include_fields ? { include_fields } : {}),
        ...(filters ? { filters } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'retrieve_dataset_log',
    'Retrieve a specific log from a dataset by its unique ID.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      unique_id: z.string().describe('The unique identifier of the log to retrieve.'),
    },
    async ({ dataset_id, unique_id }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.retrieveDatasetLog({ Authorization: c.auth, dataset_id, unique_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'import_dataset_logs',
    'Import existing logs into a dataset by time range and filters. Runs in the background.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      start_time: z.string().describe('Start time in ISO 8601 format.'),
      end_time: z.string().describe('End time in ISO 8601 format.'),
      filters: z
        .record(z.object({
          operator: z.string().optional(),
          value: z.any().optional(),
        }))
        .optional()
        .describe('Filters to select which logs to import. Example: { "model": { "operator": "", "value": "gpt-4o" } }'),
      sampling_percentage: z.number().optional().describe('Percent of matching logs to import (1-100).'),
    },
    async ({ dataset_id, start_time, end_time, filters, sampling_percentage }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.importDatasetLogs({
        Authorization: c.auth,
        dataset_id,
        start_time,
        end_time,
        ...(filters ? { filters } : {}),
        ...(sampling_percentage ? { sampling_percentage } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'delete_dataset',
    'Permanently delete a dataset and all its logs. This action cannot be undone.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset to delete.'),
    },
    async ({ dataset_id }) => {
      const c = requireClient(client);
      await c.client.datasets.deleteDataset({ Authorization: c.auth, dataset_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, dataset_id }, null, 2) }],
      };
    },
  );

  server.tool(
    'replace_dataset_log',
    'Replace (full overwrite) a log in a dataset. Updates input, output, expected_output, and/or metadata fields.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      unique_id: z.string().describe('The unique identifier of the log to replace.'),
      input: z.any().optional().describe('Input data for the log.'),
      output: z.any().optional().describe('Output data for the log.'),
      expected_output: z.any().optional().describe('Expected output for evaluation.'),
      prompt: z.string().optional().describe('Prompt text.'),
      completion: z.string().optional().describe('Completion text.'),
      metadata: z.record(z.any()).optional().describe('Metadata key-value pairs.'),
    },
    async ({ dataset_id, unique_id, input, output, expected_output, prompt, completion, metadata }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.replaceDatasetLog({
        Authorization: c.auth,
        dataset_id,
        unique_id,
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(expected_output !== undefined ? { expected_output } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(completion !== undefined ? { completion } : {}),
        ...(metadata ? { metadata } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'remove_dataset_logs',
    'Remove one or more logs from a dataset by filter. To delete a single log, pass filter { unique_id: { operator: "eq", value: "<log_id>" } }. Pass is_deleting_all_logs=true to wipe the dataset contents.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      is_deleting_all_logs: z.boolean().optional().describe('Set to true to remove every log in the dataset.'),
      filters: z
        .record(z.object({
          operator: z.string().optional().describe('Filter operator (e.g. "eq", "icontains", "gt")'),
          value: z.any().optional().describe('Filter value'),
        }))
        .optional()
        .describe('Filters keyed by field name. Example: { "status_code": { "operator": "eq", "value": 500 } }'),
    },
    async ({ dataset_id, is_deleting_all_logs, filters }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.removeDatasetLogs({
        Authorization: c.auth,
        dataset_id,
        ...(is_deleting_all_logs !== undefined ? { is_deleting_all_logs } : {}),
        ...(filters ? { filters } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'summarize_dataset_logs',
    'Get aggregated summary statistics for logs in a dataset. Pass filters to scope the summary; omit filters to summarize all logs.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      filters: z
        .record(z.object({
          operator: z.string().optional(),
          value: z.any().optional(),
        }))
        .optional()
        .describe('Optional filters keyed by field name. Example: { "status_code": { "operator": "eq", "value": 200 } }. Omit to summarize all logs.'),
    },
    async ({ dataset_id, filters }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.summarizeDatasetLogsFiltered({
        Authorization: c.auth,
        dataset_id,
        ...(filters ? { filters } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'bulk_create_dataset_logs',
    'Create one or more logs in a dataset. Pass a single-item array to insert one log. Each log can include input, output, expected_output, metadata, and metrics.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset. Use "_saved_logs" for the virtual saved-logs collection.'),
      logs: z
        .array(
          z.object({
            input: z.any().optional().describe('Input data.'),
            output: z.any().optional().describe('Output data.'),
            expected_output: z.any().optional().describe('Expected output for evaluation.'),
            metadata: z.record(z.any()).optional().describe('Metadata key-value pairs.'),
            metrics: z.record(z.any()).optional().describe('Metrics (e.g. tokens, cost, latency).'),
          })
        )
        .describe('Array of log entries to create.'),
    },
    async ({ dataset_id, logs }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.bulkCreateDatasetLogs({
        Authorization: c.auth,
        dataset_id,
        logs,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'list_dataset_eval_runs',
    'List evaluation run results for a dataset. Shows past eval runs with status and results.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      page: z.number().optional().describe('Page number.'),
      page_size: z.number().optional().describe('Results per page (max 100).'),
    },
    async ({ dataset_id, page, page_size }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.listDatasetEvalRuns({
        Authorization: c.auth,
        dataset_id,
        ...(page ? { page } : {}),
        ...(page_size ? { page_size } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
