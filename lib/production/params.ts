// lib/production/params.ts
//
// Inputs shared by the production tools: the time window, environment,
// paging, and the advanced filter condition.

import { z } from "zod";

/** EnvironmentChoices in the backend (utils/constants/environment_constants.py). */
export const ENVIRONMENTS = ["prod", "stage", "test"] as const;

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const timeWindowShape = {
  start_time: z
    .string()
    .optional()
    .describe("Start of the time range, ISO 8601 (e.g. 2026-09-30T00:00:00Z). Default: 24 hours before end_time."),
  end_time: z.string().optional().describe("End of the time range, ISO 8601. Default: now."),
};

export const environmentShape = {
  environment: z
    .enum(ENVIRONMENTS)
    .optional()
    .describe("Only include this environment. Default: all environments."),
};

export function pageShape(defaultSize: number, maxSize: number) {
  return {
    page: z.number().int().min(1).optional().describe("Page number, starting at 1 (default 1)."),
    page_size: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Rows per page (default ${defaultSize}, max ${maxSize}).`),
  };
}

export function resolvePage(
  args: { page?: number; page_size?: number },
  defaultSize: number,
  maxSize: number,
) {
  return {
    page: args.page ?? 1,
    pageSize: Math.min(args.page_size ?? defaultSize, maxSize),
  };
}

function parseTime(value: string, name: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be an ISO 8601 timestamp, got "${value}".`);
  }
  return parsed;
}

/** Fills in the default 24-hour window and normalizes both ends to ISO 8601. */
export function resolveTimeWindow(args: { start_time?: string; end_time?: string }) {
  const end = args.end_time ? parseTime(args.end_time, "end_time") : new Date();
  const start = args.start_time
    ? parseTime(args.start_time, "start_time")
    : new Date(end.getTime() - DEFAULT_WINDOW_MS);
  if (start >= end) throw new Error("start_time must be before end_time.");
  return { start_time: start.toISOString(), end_time: end.toISOString() };
}

/** Operators the backend ClickHouse filter compiler accepts (no `iexact`). */
export const FILTER_OPERATORS = [
  "",
  "not",
  "in",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "icontains",
  "startswith",
  "endswith",
  "isnull",
] as const;

export function filterConditionSchema(fieldDescription: string) {
  return z.object({
    field: z.string().describe(fieldDescription),
    operator: z
      .enum(FILTER_OPERATORS)
      .describe("'' = equals, 'not' = not equal, 'in' = any of the values, 'lt'/'lte'/'gt'/'gte' = comparisons, 'icontains' = case-insensitive substring, 'isnull' = null check."),
    value: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .describe("Value(s) as an array, e.g. [5], ['gpt-4o'], [true]."),
  });
}

export type BackendFilters = Record<string, { operator: string; value: unknown }>;
