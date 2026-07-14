import { ident } from '../db.js';

const OPS: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'like',
  ilike: 'ilike',
};

export interface ParsedQuery {
  where: string;
  params: any[];
  orderBy: string;
  limit: number | null;
  offset: number | null;
  select: string;
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset']);

/**
 * Parse a PostgREST-style query string into a SQL fragment.
 * Examples:
 *   ?id=eq.5&done=is.false
 *   ?title=ilike.*welcome*
 *   ?select=id,title&order=created_at.desc&limit=10
 *   ?id=in.(1,2,3)
 */
export function parseQuery(
  q: Record<string, string | string[]>,
  validCols: Set<string>,
): ParsedQuery {
  const clauses: string[] = [];
  const params: any[] = [];
  let p = 0;

  for (const [key, rawVal] of Object.entries(q)) {
    if (RESERVED.has(key)) continue;
    if (!validCols.has(key)) {
      throw Object.assign(new Error(`Unknown column in filter: ${key}`), { statusCode: 400 });
    }
    const value = Array.isArray(rawVal) ? rawVal[0] : rawVal;
    const dot = value.indexOf('.');
    const op = dot === -1 ? 'eq' : value.slice(0, dot);
    const operand = dot === -1 ? value : value.slice(dot + 1);
    const col = ident(key);

    if (op === 'is') {
      const v = operand.toLowerCase();
      if (v === 'null') clauses.push(`${col} is null`);
      else if (v === 'true') clauses.push(`${col} is true`);
      else if (v === 'false') clauses.push(`${col} is false`);
      else throw Object.assign(new Error(`invalid 'is' operand: ${operand}`), { statusCode: 400 });
      continue;
    }

    if (op === 'in') {
      // operand looks like (a,b,c)
      const inner = operand.replace(/^\(/, '').replace(/\)$/, '');
      const items = inner.length ? inner.split(',') : [];
      if (!items.length) {
        clauses.push('false');
        continue;
      }
      const placeholders = items.map(() => `$${++p}`);
      params.push(...items);
      clauses.push(`${col} in (${placeholders.join(',')})`);
      continue;
    }

    const sqlOp = OPS[op];
    if (!sqlOp) throw Object.assign(new Error(`unknown operator: ${op}`), { statusCode: 400 });

    let operandValue: string = operand;
    if (op === 'like' || op === 'ilike') {
      operandValue = operand.replace(/\*/g, '%');
    }
    params.push(operandValue);
    clauses.push(`${col} ${sqlOp} $${++p}`);
  }

  // SELECT
  let select = '*';
  if (q.select) {
    const cols = String(Array.isArray(q.select) ? q.select[0] : q.select)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    for (const c of cols) {
      if (!validCols.has(c)) throw Object.assign(new Error(`Unknown column in select: ${c}`), { statusCode: 400 });
    }
    select = cols.map(ident).join(', ');
  }

  // ORDER
  let orderBy = '';
  if (q.order) {
    const spec = String(Array.isArray(q.order) ? q.order[0] : q.order);
    const parts = spec.split(',').map((s) => {
      const [c, dir] = s.split('.');
      if (!validCols.has(c)) throw Object.assign(new Error(`Unknown column in order: ${c}`), { statusCode: 400 });
      const d = (dir ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
      return `${ident(c)} ${d}`;
    });
    orderBy = parts.join(', ');
  }

  const limit = q.limit ? Number(Array.isArray(q.limit) ? q.limit[0] : q.limit) : null;
  const offset = q.offset ? Number(Array.isArray(q.offset) ? q.offset[0] : q.offset) : null;

  return {
    where: clauses.length ? `where ${clauses.join(' and ')}` : '',
    params,
    orderBy,
    limit: Number.isFinite(limit as number) ? limit : null,
    offset: Number.isFinite(offset as number) ? offset : null,
    select,
  };
}
