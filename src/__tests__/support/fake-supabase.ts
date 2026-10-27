import type { SupabaseClient } from "@supabase/supabase-js";

// A chainable stand-in for the Supabase client in unit tests. Every query is
// recorded (table, operation, columns, values, filters) and answered by the
// test's handler, so tests assert on exactly what would reach PostgREST.

export type FakeError = { code?: string; message?: string };
export type FakeResult = { data?: unknown; error?: FakeError | null; count?: number | null };

export type FakeQuery = {
  table: string;
  operation: "select" | "insert" | "update" | "upsert" | "delete";
  /** Columns of a select, or the `returning` columns after a write. */
  columns?: string;
  values?: unknown;
  options?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
  single: "single" | "maybeSingle" | null;
};

export type FakeRpc = { fn: string; args: Record<string, unknown> };

export type FakeHandlers = {
  from?: (query: FakeQuery) => FakeResult | Promise<FakeResult>;
  rpc?: (call: FakeRpc) => FakeResult | Promise<FakeResult>;
};

const FILTER_METHODS = ["eq", "neq", "in", "is", "not", "or", "gte", "gt", "lte", "lt", "like", "ilike", "overlaps", "contains", "match", "filter", "order", "limit", "range"];

function settle(result: FakeResult | undefined) {
  return { data: result?.data ?? null, error: result?.error ?? null, count: result?.count ?? null };
}

export function createFakeSupabase(handlers: FakeHandlers = {}) {
  const queries: FakeQuery[] = [];
  const rpcs: FakeRpc[] = [];

  function from(table: string) {
    const query: FakeQuery = { table, operation: "select", filters: [], single: null };
    const chain: Record<string, unknown> = {};
    for (const method of FILTER_METHODS) {
      chain[method] = (...args: unknown[]) => {
        query.filters.push({ method, args });
        return chain;
      };
    }
    chain.select = (columns?: string, options?: unknown) => {
      query.columns = columns;
      if (query.operation === "select") query.options = options;
      return chain;
    };
    for (const operation of ["insert", "update", "upsert", "delete"] as const) {
      chain[operation] = (values?: unknown, options?: unknown) => {
        query.operation = operation;
        query.values = values;
        query.options = options;
        return chain;
      };
    }
    chain.single = () => {
      query.single = "single";
      return chain;
    };
    chain.maybeSingle = () => {
      query.single = "maybeSingle";
      return chain;
    };
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
      queries.push(query);
      return Promise.resolve(handlers.from?.(query)).then(settle).then(resolve, reject);
    };
    return chain;
  }

  function rpc(fn: string, args: Record<string, unknown> = {}) {
    const call = { fn, args };
    return {
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        rpcs.push(call);
        return Promise.resolve(handlers.rpc?.(call)).then(settle).then(resolve, reject);
      },
    };
  }

  return { client: { from, rpc } as unknown as SupabaseClient, queries, rpcs };
}

/** The value of the first `method(column, value)` filter on a query, e.g. `filter(query, "eq", "garage_id")`. */
export function filterValue(query: FakeQuery, method: string, column: string): unknown {
  return query.filters.find((filter) => filter.method === method && filter.args[0] === column)?.args[1];
}

export function hasFilter(query: FakeQuery, method: string, column: string, value?: unknown) {
  return query.filters.some((filter) => filter.method === method && filter.args[0] === column && (value === undefined || JSON.stringify(filter.args[1]) === JSON.stringify(value)));
}
