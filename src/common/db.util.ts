/**
 * Knex types `.first()` as `T | undefined` under `strictNullChecks`, since in
 * general there's no guarantee a query returns a row. For a bare aggregate
 * query with no GROUP BY (COUNT/MAX/etc.), Postgres always returns exactly
 * one row at runtime — so `undefined` never actually happens here — but the
 * type system has no way to know that.
 *
 * This helper makes the (safe) assumption explicit in one place instead of
 * repeating `row?.key ?? 0` at every call site. If a row genuinely is
 * missing for some unexpected reason, it falls back to 0 rather than
 * throwing, since these are always used for read-side counts/pagination
 * totals, not for existence checks (those use `.first()` directly and
 * already throw `NotFoundException` when a row is legitimately absent).
 */
export function aggregateValue(
  row: Record<string, string | number> | undefined,
  key: string,
): number {
  return Number(row?.[key] ?? 0);
}
