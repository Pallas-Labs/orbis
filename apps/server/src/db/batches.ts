import { getTableColumns } from "drizzle-orm";
import type { Table } from "drizzle-orm";

// A Durable Object's SQLite binds at most 100 values in one statement.
const MAX_BOUND_VALUES = 100;

// Splits values so that each statement, which binds `fixed` values of its own and
// `perValue` for each value in its batch, stays within the Group's limit.
export const boundBatches = <Value>(
  values: readonly Value[],
  binds: { readonly fixed: number; readonly perValue: number }
): Value[][] => {
  const size = Math.floor((MAX_BOUND_VALUES - binds.fixed) / binds.perValue);
  const batches: Value[][] = [];
  for (let at = 0; at < values.length; at += size) {
    batches.push(values.slice(at, at + size));
  }
  return batches;
};

// Splits rows into inserts the Group accepts. Each row binds at most one value per column.
export const insertBatches = <Row>(table: Table, rows: readonly Row[]) =>
  boundBatches(rows, {
    fixed: 0,
    perValue: Object.keys(getTableColumns(table)).length,
  });
