/**
 * @kobedb/client — a small isomorphic client for KobeDB.
 *
 *   const db = createClient('http://localhost:8000');
 *   await db.auth.signUp('a@b.com', 'secret');
 *   const { data } = await db.from('todos').select().eq('done', false).order('created_at', 'desc').get();
 *   db.channel('todos').on('*', (e) => console.log(e)).subscribe();
 */

export interface Session {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; role: string };
}

type Op = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is';

class QueryBuilder<T = any> {
  private filters: string[] = [];
  private _select = '*';
  private _order = '';
  private _limit?: number;
  private _offset?: number;

  constructor(
    private base: string,
    private table: string,
    private getHeaders: () => Record<string, string>,
  ) {}

  select(cols = '*') { this._select = cols; return this; }
  order(col: string, dir: 'asc' | 'desc' = 'asc') { this._order = `${col}.${dir}`; return this; }
  limit(n: number) { this._limit = n; return this; }
  offset(n: number) { this._offset = n; return this; }

  private filter(col: string, op: Op, val: any) {
    if (op === 'in') this.filters.push(`${col}=in.(${(val as any[]).join(',')})`);
    else this.filters.push(`${col}=${op}.${val}`);
    return this;
  }
  eq(c: string, v: any) { return this.filter(c, 'eq', v); }
  neq(c: string, v: any) { return this.filter(c, 'neq', v); }
  gt(c: string, v: any) { return this.filter(c, 'gt', v); }
  gte(c: string, v: any) { return this.filter(c, 'gte', v); }
  lt(c: string, v: any) { return this.filter(c, 'lt', v); }
  lte(c: string, v: any) { return this.filter(c, 'lte', v); }
  like(c: string, v: string) { return this.filter(c, 'like', v); }
  ilike(c: string, v: string) { return this.filter(c, 'ilike', v); }
  in(c: string, v: any[]) { return this.filter(c, 'in', v); }
  is(c: string, v: 'null' | boolean) { return this.filter(c, 'is', v); }

  private qs() {
    const parts = [...this.filters];
    if (this._select !== '*') parts.push(`select=${this._select}`);
    if (this._order) parts.push(`order=${this._order}`);
    if (this._limit != null) parts.push(`limit=${this._limit}`);
    if (this._offset != null) parts.push(`offset=${this._offset}`);
    return parts.length ? '?' + parts.join('&') : '';
  }

  private url() { return `${this.base}/rest/v1/${this.table}${this.qs()}`; }

  async get(): Promise<{ data: T[]; error: string | null }> {
    return req(this.url(), { headers: this.getHeaders() });
  }
  async insert(rows: Partial<T> | Partial<T>[]) {
    return req(`${this.base}/rest/v1/${this.table}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...this.getHeaders() }, body: JSON.stringify(rows),
    });
  }
  async update(patch: Partial<T>) {
    return req(this.url(), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...this.getHeaders() }, body: JSON.stringify(patch),
    });
  }
  async delete() {
    return req(this.url(), { method: 'DELETE', headers: this.getHeaders() });
  }
}

async function req(url: string, opts: any): Promise<{ data: any; error: string | null }> {
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let body: any; try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) return { data: null, error: body?.error ?? res.statusText };
    return { data: body, error: null };
  } catch (e: any) {
    return { data: null, error: e.message };
  }
}

class RealtimeChannel {
  private ws?: WebSocket;
  private handlers: ((e: any) => void)[] = [];
  constructor(private base: string, private table: string) {}

  on(_event: '*' | 'INSERT' | 'UPDATE' | 'DELETE', cb: (e: any) => void) {
    this.handlers.push(cb);
    return this;
  }
  subscribe() {
    const url = this.base.replace(/^http/, 'ws') + '/realtime/v1';
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.ws!.send(JSON.stringify({ action: 'subscribe', table: this.table }));
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data as string);
      if (msg.event === 'change') for (const cb of this.handlers) cb(msg.payload);
    };
    return this;
  }
  unsubscribe() { this.ws?.close(); }
}

export class KobeClient {
  private session: Session | null = null;
  constructor(private url: string) {}

  private headers(): Record<string, string> {
    return this.session ? { Authorization: `Bearer ${this.session.access_token}` } : {};
  }

  auth = {
    signUp: async (email: string, password: string) => {
      const r = await req(`${this.url}/auth/v1/signup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
      });
      if (!r.error) this.session = r.data;
      return r;
    },
    signIn: async (email: string, password: string) => {
      const r = await req(`${this.url}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
      });
      if (!r.error) this.session = r.data;
      return r;
    },
    signOut: async () => {
      if (this.session) await req(`${this.url}/auth/v1/logout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: this.session.refresh_token }),
      });
      this.session = null;
    },
    // Passwordless magic link. Returns the action_link (dev) / triggers email (prod).
    signInWithOtp: async (email: string) =>
      req(`${this.url}/auth/v1/magiclink`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
      }),
    // Build the URL to start an OAuth flow (redirect the browser here).
    getOAuthUrl: (provider: 'google' | 'github', redirectTo?: string) =>
      `${this.url}/auth/v1/authorize?provider=${provider}` +
      (redirectTo ? `&redirect_to=${encodeURIComponent(redirectTo)}` : ''),
    signInWithOAuth: (provider: 'google' | 'github', redirectTo?: string) => {
      const url = this.auth.getOAuthUrl(provider, redirectTo);
      if (typeof window !== 'undefined') window.location.href = url;
      return url;
    },
    user: () => this.session?.user ?? null,
    getSession: () => this.session,
    setSession: (s: Session | null) => { this.session = s; },
  };

  /** Invoke an edge function by name. */
  functions = {
    invoke: async (name: string, options: { method?: string; body?: any } = {}) => {
      const method = options.method ?? 'POST';
      const hasBody = method !== 'GET' && options.body !== undefined;
      return req(`${this.url}/functions/v1/${name}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: hasBody ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
      });
    },
  };

  from<T = any>(table: string) {
    return new QueryBuilder<T>(this.url, table, () => this.headers());
  }

  channel(table: string) {
    return new RealtimeChannel(this.url, table);
  }

  storage = {
    upload: async (bucket: string, name: string, data: Blob | ArrayBuffer | Uint8Array, contentType?: string) => {
      return req(`${this.url}/storage/v1/object/${bucket}/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': contentType ?? 'application/octet-stream', ...this.headers() },
        body: data as any,
      });
    },
    list: async (bucket: string) => req(`${this.url}/storage/v1/object/list/${bucket}`, { headers: this.headers() }),
    getPublicUrl: (bucket: string, name: string) => `${this.url}/storage/v1/object/${bucket}/${encodeURIComponent(name)}`,
    remove: async (bucket: string, name: string) =>
      req(`${this.url}/storage/v1/object/${bucket}/${encodeURIComponent(name)}`, { method: 'DELETE', headers: this.headers() }),
  };
}

export function createClient(url: string): KobeClient {
  return new KobeClient(url.replace(/\/$/, ''));
}
