// ----------------------------------------------------------------------------
// A BOUNDED QUERY ADAPTER for the ported evidence producers.
//
// Eleven of the Audit's evidence modules read the warehouse through a PostgREST-style
// builder (`db.from(t).select(c).eq(...).order(...)`). Rewriting each of them by hand
// would mean re-expressing hundreds of query call sites in a different dialect, and every
// one of those rewrites is a chance to silently change WHICH ROWS a metric is computed
// from -- exactly the kind of change the frozen engine must not absorb during a move.
//
// So the builder shape is preserved and re-implemented over this workspace's pg pool.
// This is deliberately NOT a general PostgREST client: it implements exactly the operator
// set those modules actually use, enumerated from their source --
//
//   select · eq · in · gte · lte · gt · lt · ilike · is · not · order · limit · range
//   · maybeSingle · rpc
//
// -- and throws on anything else. A missing operator therefore fails loudly at the call
// site instead of quietly returning the wrong rows, which is the only failure mode that
// matters here: a query that returns plausible-but-wrong evidence is indistinguishable
// from real evidence once it reaches the engine.
//
// Identifiers are validated before interpolation; every value is bound as a parameter.
// ----------------------------------------------------------------------------
import { pool } from "@workspace/db";

export interface QueryResult<T = Record<string, unknown>> {
  data: T[] | null;
  error: { message: string } | null;
}
export interface SingleResult<T = Record<string, unknown>> {
  data: T | null;
  error: { message: string } | null;
}

const IDENT = /^[a-z_][a-z0-9_]*$/i;

function ident(name: string): string {
  const trimmed = name.trim();
  if (!IDENT.test(trimmed)) throw new Error(`[audit-evidence] Refusing unsafe SQL identifier: ${name}`);
  return `"${trimmed}"`;
}

/**
 * PostgREST's select list: comma-separated column names. Embedded-resource syntax
 * (`a(b)`) is not supported and is rejected rather than silently dropped -- none of the
 * ported modules use it, and a silent drop would change the returned row shape.
 */
function selectList(columns: string): string {
  const trimmed = columns.trim();
  if (trimmed === "*" || trimmed === "") return "*";
  if (trimmed.includes("(")) {
    throw new Error(`[audit-evidence] Embedded-resource select is not supported: ${columns}`);
  }
  return trimmed.split(",").map((c) => ident(c)).join(", ");
}

class Query implements PromiseLike<QueryResult> {
  private readonly conditions: string[] = [];
  private readonly params: unknown[] = [];
  private columns = "*";
  private orderBy: string[] = [];
  private limitValue: number | null = null;
  private offsetValue = 0;

  constructor(private readonly table: string) {}

  private bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  select(columns = "*"): this {
    this.columns = selectList(columns);
    return this;
  }

  eq(column: string, value: unknown): this {
    this.conditions.push(`${ident(column)} = ${this.bind(value)}`);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    // An empty IN list matches nothing, which is what PostgREST does; `= any('{}')` keeps
    // that true without special-casing the SQL.
    this.conditions.push(`${ident(column)} = any(${this.bind([...values])})`);
    return this;
  }

  gte(column: string, value: unknown): this { this.conditions.push(`${ident(column)} >= ${this.bind(value)}`); return this; }
  lte(column: string, value: unknown): this { this.conditions.push(`${ident(column)} <= ${this.bind(value)}`); return this; }
  gt(column: string, value: unknown): this { this.conditions.push(`${ident(column)} > ${this.bind(value)}`); return this; }
  lt(column: string, value: unknown): this { this.conditions.push(`${ident(column)} < ${this.bind(value)}`); return this; }

  ilike(column: string, pattern: string): this {
    this.conditions.push(`${ident(column)} ilike ${this.bind(pattern)}`);
    return this;
  }

  /** PostgREST `.is(col, null)` — the null check, not an equality. */
  is(column: string, value: null | boolean): this {
    this.conditions.push(`${ident(column)} is ${value === null ? "null" : value ? "true" : "false"}`);
    return this;
  }

  /** PostgREST `.not(col, op, value)`; only the operators the ported modules use. */
  not(column: string, operator: string, value: unknown): this {
    switch (operator) {
      case "is":
        this.conditions.push(`${ident(column)} is not ${value === null ? "null" : value ? "true" : "false"}`);
        return this;
      case "eq":
        this.conditions.push(`${ident(column)} is distinct from ${this.bind(value)}`);
        return this;
      case "in":
        this.conditions.push(`not (${ident(column)} = any(${this.bind([...(value as unknown[])])}))`);
        return this;
      default:
        throw new Error(`[audit-evidence] Unsupported .not() operator: ${operator}`);
    }
  }

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const direction = options?.ascending === false ? "desc" : "asc";
    const nulls = options?.nullsFirst === undefined ? "" : options.nullsFirst ? " nulls first" : " nulls last";
    this.orderBy.push(`${ident(column)} ${direction}${nulls}`);
    return this;
  }

  limit(count: number): this { this.limitValue = Math.max(0, Math.floor(count)); return this; }

  /** PostgREST ranges are INCLUSIVE on both ends. */
  range(from: number, to: number): this {
    this.offsetValue = Math.max(0, Math.floor(from));
    this.limitValue = Math.max(0, Math.floor(to) - this.offsetValue + 1);
    return this;
  }

  private toSql(): { text: string; params: unknown[] } {
    let text = `select ${this.columns} from ${ident(this.table)}`;
    if (this.conditions.length) text += ` where ${this.conditions.join(" and ")}`;
    if (this.orderBy.length) text += ` order by ${this.orderBy.join(", ")}`;
    if (this.limitValue !== null) text += ` limit ${this.limitValue}`;
    if (this.offsetValue) text += ` offset ${this.offsetValue}`;
    return { text, params: this.params };
  }

  private async run(): Promise<QueryResult> {
    const { text, params } = this.toSql();
    try {
      const result = await pool.query(text, params);
      return { data: result.rows as Array<Record<string, unknown>>, error: null };
    } catch (error) {
      // Returned rather than thrown: the ported modules all branch on `error`, and several
      // treat a failed read as "this source had nothing" only AFTER inspecting it. Throwing
      // here would convert a handled read failure into an unhandled stage crash.
      return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  }

  async maybeSingle(): Promise<SingleResult> {
    this.limitValue = this.limitValue ?? 1;
    const { data, error } = await this.run();
    if (error) return { data: null, error };
    return { data: data && data.length ? data[0]! : null, error: null };
  }

  then<R1 = QueryResult, R2 = never>(
    onfulfilled?: ((value: QueryResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

export const auditWarehouseDb = {
  from(table: string) {
    return new Query(table);
  },
  /**
   * Only the evidence-warehouse upsert is reached this way (see
   * lib/db/src/sql/tennis-matrix-audit.sql). Any other function name is refused rather
   * than passed through to the database.
   */
  async rpc(fn: string, args: Record<string, unknown>): Promise<SingleResult> {
    if (fn !== "upsert_metric_evidence_side") {
      throw new Error(`[audit-evidence] Unsupported rpc: ${fn}`);
    }
    try {
      const result = await pool.query(`select public.upsert_metric_evidence_side($1::jsonb) as row`, [
        JSON.stringify(args["p_payload"] ?? {}),
      ]);
      return { data: (result.rows[0] as Record<string, unknown> | undefined) ?? null, error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  },
};

/** The name the ported modules import. */
export const supabaseAdmin = auditWarehouseDb;
