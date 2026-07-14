import { query } from '../db.js';
import type { AuthContext } from '../auth/middleware.js';

export type Action = 'select' | 'insert' | 'update' | 'delete';

interface PolicyRow {
  table_name: string;
  action: Action;
  roles: string[];
  owner_column: string | null;
  columns: string[] | null;
}

interface TablePolicies {
  rlsEnabled: boolean;
  policies: PolicyRow[];
}

// Short-lived cache so we don't hit the catalog on every request.
let cache: Map<string, TablePolicies> | null = null;
let cacheAt = 0;

async function load(): Promise<Map<string, TablePolicies>> {
  const now = Date.now();
  if (cache && now - cacheAt < 5000) return cache;

  const rls = await query<{ table_name: string; enabled: boolean }>(
    `select table_name, enabled from kobedb.rls`,
  );
  const pol = await query<PolicyRow>(
    `select table_name, action, roles, owner_column, columns from kobedb.policies`,
  );

  const map = new Map<string, TablePolicies>();
  for (const r of rls.rows) {
    map.set(r.table_name, { rlsEnabled: r.enabled, policies: [] });
  }
  for (const p of pol.rows) {
    if (!map.has(p.table_name)) map.set(p.table_name, { rlsEnabled: true, policies: [] });
    map.get(p.table_name)!.policies.push(p);
  }
  cache = map;
  cacheAt = now;
  return map;
}

export interface PolicyDecision {
  allowed: boolean;
  /** If set, scope rows to `ownerColumn = auth.uid`. */
  ownerColumn: string | null;
  /** Columns this role may read/write; null means all columns are allowed. */
  columns: string[] | null;
  /** True when this table is governed by the policy engine (RLS enabled). */
  rlsManaged: boolean;
  reason?: string;
}

/**
 * Decide whether `ctx` may perform `action` on `table`.
 *  - service_role always bypasses.
 *  - Tables without RLS keep the default (open read / authenticated write) — signalled
 *    by `allowed: true, ownerColumn: null` and the caller applies its own default gate.
 *  - Tables with RLS: a matching policy for (action, role) is required, else denied.
 */
export async function evaluate(
  table: string,
  action: Action,
  ctx: AuthContext,
): Promise<PolicyDecision> {
  if (ctx.role === 'service_role')
    return { allowed: true, ownerColumn: null, columns: null, rlsManaged: false };

  const map = await load();
  const tp = map.get(table);

  // No RLS configured for this table → defer to default gate in the route.
  if (!tp || !tp.rlsEnabled)
    return { allowed: true, ownerColumn: null, columns: null, rlsManaged: false };

  const matches = tp.policies.filter(
    (p) => p.action === action && p.roles.includes(ctx.role),
  );
  if (matches.length === 0) {
    return {
      allowed: false,
      ownerColumn: null,
      columns: null,
      rlsManaged: true,
      reason: `no policy allows ${action} on ${table} for role ${ctx.role}`,
    };
  }

  // If any matching policy is owner-scoped, enforce ownership. (We use the first
  // owner_column found; unscoped policies grant table-wide access.)
  const scoped = matches.find((m) => m.owner_column);
  const unscoped = matches.some((m) => !m.owner_column);

  // Column allow-list: if any matching policy is unrestricted (null/empty columns),
  // all columns are allowed; otherwise the union of the listed columns.
  const anyUnrestricted = matches.some((m) => !m.columns || m.columns.length === 0);
  const columns = anyUnrestricted
    ? null
    : [...new Set(matches.flatMap((m) => m.columns ?? []))];

  return {
    allowed: true,
    ownerColumn: unscoped ? null : scoped?.owner_column ?? null,
    columns,
    rlsManaged: true,
  };
}

/** Force a refresh (used after policy changes via the admin API). */
export function invalidatePolicyCache() {
  cache = null;
}
