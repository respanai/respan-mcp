// lib/shared/tool-result.ts
//
// Pieces every tool handler shares: the annotation set for tools that only
// read the caller's workspace, and JSON results kept inside a size budget so
// one large log or trace cannot flood the client's context.

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Reads the caller's own Respan workspace and changes nothing. */
export const READ_ONLY_WORKSPACE_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Backend fields that describe Respan's own bookkeeping rather than the
 * caller's data: org and key identifiers, gateway pricing internals, storage
 * pointers, and raw request/response copies of the parsed messages.
 */
export const INTERNAL_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  "organization_id",
  "unique_organization_id",
  "organization_name",
  "user_email",
  "storage_object_key",
  "keywordsai_params",
  "full_request",
  "full_request_openai",
  "full_response",
  "matched_meter_ids",
  "unit_prices",
  "component_costs",
  "llm_gateway_markup_rate",
  "model_discount",
  "pricing_tier",
  "load_balance_group_id",
  "blurred",
  "io_format",
  "format_version",
  "input_words",
  "output_words",
  "input_chars",
  "output_chars",
  "system_text",
  "prompt_text",
  "completion_text",
  // Credentials a write response may echo (a new webhook's signing secrets).
  "secrets",
  "secret",
  "webhook_secret",
  "signing_secret",
]);

export interface JsonBudget {
  /** Upper bound on the serialized result, in characters. */
  maxChars: number;
  /** Per-string caps tried in order until the result fits. */
  stringCaps: readonly number[];
}

/**
 * Replaces every string longer than `maxChars` with its prefix and a marker,
 * unless the marker would make it longer. `cuts.count` counts the strings cut.
 */
export function truncateStrings(value: unknown, maxChars: number, cuts?: { count: number }): unknown {
  if (typeof value === "string") {
    if (value.length <= maxChars) return value;
    const marker = `…[truncated ${value.length - maxChars} chars]`;
    if (marker.length >= value.length - maxChars) return value;
    if (cuts) cuts.count += 1;
    return `${value.slice(0, maxChars)}${marker}`;
  }
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, maxChars, cuts));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, truncateStrings(item, maxChars, cuts)]),
    );
  }
  return value;
}

/** Drops `keys` at every depth of `value`. */
export function omitKeys(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => omitKeys(item, keys));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !keys.has(key))
        .map(([key, item]) => [key, omitKeys(item, keys)]),
    );
  }
  return value;
}

/**
 * Serializes `value`, shortening long strings step by step until the text
 * fits the budget. Returns the last attempt when no step fits, so callers that
 * need a hard bound check the length themselves.
 */
export function budgetedJson(value: unknown, budget: JsonBudget): string {
  let text = JSON.stringify(value);
  for (const cap of budget.stringCaps) {
    if (text.length <= budget.maxChars) break;
    text = JSON.stringify(truncateStrings(value, cap));
  }
  return text;
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Rows and a has-more flag from a backend list response. The list endpoints'
 * `count` is the length of the returned page, not a total, so it is not read.
 */
export function readListPage(result: unknown, pageSize: number) {
  const body = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const rows: unknown[] = Array.isArray(result)
    ? result
    : Array.isArray(body.results)
      ? body.results
      : Array.isArray(body.data)
        ? body.data
        : [];
  const hasMore = typeof body.next === "string" || (body.next === undefined && rows.length === pageSize);
  return { rows, hasMore };
}

export interface ListPage {
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface PageBudget extends JsonBudget {
  /** Every string in a row is first cut to this preview length. */
  previewChars: number;
  /**
   * Top-level row keys never shortened: ids and names the caller passes back
   * to a detail tool or a filter. A row that does not fit is reduced to these.
   */
  keepWhole: readonly string[];
  /** Extra advice when rows were reduced, e.g. how to ask for smaller rows. */
  smallerRowsHint?: string;
}

/**
 * Serializes one page of list rows within `budget`, and never cuts silently.
 * Strings are cut to `previewChars`, then shortened further through
 * `stringCaps`; `keepWhole` keys stay intact. If the rows still do not fit,
 * rows are reduced to their `keepWhole` keys from the end of the page, so
 * every row stays on the page and `next_page` stays valid. The page says what
 * happened: `returned`, `truncated` with a hint, and `next_page`. Only when
 * even id-only rows cannot fit are rows dropped, and then `next_page` is
 * withheld, since it would skip them.
 */
export function budgetedPage(
  envelope: Record<string, unknown> & ListPage,
  rows: readonly unknown[],
  budget: PageBudget,
  detailHint: string,
): string {
  const keepWhole = new Set(budget.keepWhole);
  const asRecord = (row: unknown) =>
    (row && typeof row === "object" && !Array.isArray(row) ? row : {}) as Record<string, unknown>;

  // Each row shortened to `cap` (ids left whole), whether that cut anything,
  // and the row reduced to its ids.
  const shortenRows = (cap: number) =>
    rows.map((row) => {
      const cuts = { count: 0 };
      const entries = Object.entries(asRecord(row));
      const full = Object.fromEntries(
        entries.map(([key, item]) => [key, keepWhole.has(key) ? item : truncateStrings(item, cap, cuts)]),
      );
      const ids = Object.fromEntries(entries.filter(([key]) => keepWhole.has(key)));
      return { full, ids, isCut: cuts.count > 0 };
    });
  type Shortened = ReturnType<typeof shortenRows>;

  // The first `fullCount` rows in full, the next `idCount` reduced to ids.
  const render = (shortened: Shortened, cap: number, fullCount: number, idCount = rows.length - fullCount) => {
    const results = [
      ...shortened.slice(0, fullCount).map((row) => row.full),
      ...shortened.slice(fullCount, fullCount + idCount).map((row) => row.ids),
    ];
    const omittedRows = rows.length - results.length;
    const isShortened = shortened.slice(0, fullCount).some((row) => row.isCut);
    const hint = [
      isShortened ? "Long text was shortened." : undefined,
      isShortened || idCount > 0 ? detailHint : undefined,
      idCount > 0 ? `The last ${idCount} rows did not fit and show only their ids.` : undefined,
      omittedRows > 0 ? `The last ${omittedRows} rows did not fit at all; ask for this page again with a smaller page_size.` : undefined,
      idCount > 0 || omittedRows > 0 ? budget.smallerRowsHint : undefined,
    ].filter(Boolean).join(" ");
    const truncated = hint ? {
      ...(isShortened ? { strings_shortened_to: cap } : {}),
      ...(idCount > 0 ? { rows_reduced_to_ids: idCount } : {}),
      ...(omittedRows > 0 ? { omitted_rows: omittedRows } : {}),
      hint,
    } : undefined;
    return JSON.stringify({
      ...envelope,
      // Dropped rows are still unread, even on the backend's last page.
      has_more: envelope.has_more || omittedRows > 0,
      returned: results.length,
      ...(envelope.has_more && omittedRows === 0 ? { next_page: envelope.page + 1 } : {}),
      ...(truncated ? { truncated } : {}),
      results,
    });
  };

  let cap = budget.previewChars;
  let shortened = shortenRows(cap);
  let text = render(shortened, cap, rows.length);
  for (const stringCap of budget.stringCaps) {
    if (text.length <= budget.maxChars) return text;
    cap = stringCap;
    shortened = shortenRows(cap);
    text = render(shortened, cap, rows.length);
  }
  if (text.length <= budget.maxChars) return text;

  // Reduce rows to their ids from the end: find the most full rows that fit
  // by per-row length, then step down while the page (whose note grows) is over.
  const fullLengths = shortened.map((row) => JSON.stringify(row.full).length);
  const idLengths = shortened.map((row) => JSON.stringify(row.ids).length);
  let total = text.length - fullLengths.reduce((sum, n) => sum + n, 0) + idLengths.reduce((sum, n) => sum + n, 0);
  let fullCount = 0;
  while (fullCount < rows.length && total + fullLengths[fullCount] - idLengths[fullCount] <= budget.maxChars) {
    total += fullLengths[fullCount] - idLengths[fullCount];
    fullCount++;
  }
  for (; fullCount >= 0; fullCount--) {
    text = render(shortened, cap, fullCount);
    if (text.length <= budget.maxChars) return text;
  }

  // Even id-only rows do not fit: keep as many as do.
  let idCount = rows.length;
  while (idCount > 0 && text.length > budget.maxChars) {
    idCount--;
    text = render(shortened, cap, 0, idCount);
  }
  return text;
}
