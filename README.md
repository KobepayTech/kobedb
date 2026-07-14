# ⚡ KobeDB

A self-hostable, open-source backend platform — your own **Supabase-style stack**, built from scratch in TypeScript on top of PostgreSQL.

It bundles the pieces you need to ship an app without writing a backend:

| Pillar | What you get | Endpoint |
| --- | --- | --- |
| **Database + REST** | Auto-generated CRUD REST API over every table in your `public` schema, with PostgREST-style filters (`eq`, `gt`, `ilike`, `in`, `order`, `limit`, …). | `/rest/v1` |
| **Auth** | Email/password signup & login, JWT access tokens, rotating refresh tokens, **passwordless magic links**, **OAuth (Google/GitHub)**, service-role key, admin user listing. | `/auth/v1` |
| **Row-Level Security** | A policy engine: per-table read/write rules by role, owner-scoping so users only touch their own rows, and **per-column** allow-lists. Manageable via API/Studio. | `/admin/*` |
| **Backups & restore** | On-demand `pg_dump` backups with list/download/restore/delete, via API + Studio. | `/admin/backups` |
| **Realtime** | WebSocket subscriptions to row changes (INSERT/UPDATE/DELETE) via Postgres `LISTEN/NOTIFY`. | `ws://…/realtime/v1` |
| **Storage** | S3-style buckets & objects with a pluggable backend: local filesystem **or** any S3-compatible service (AWS S3, MinIO, Cloudflare R2). | `/storage/v1` |
| **Edge Functions** | Serverless functions using the Web-standard `Request`/`Response` contract, run in a **native Deno isolate** when available (OS-enforced permissions) or portable Node worker threads. | `/functions/v1` |
| **Schema designer** | Service-role DDL API + Studio UI to create/alter/drop tables and run arbitrary SQL migrations. | `/admin/schema`, `/admin/sql` |
| **Studio** | A zero-build web dashboard: table editor, schema designer, SQL runner, auth manager, RLS policies, storage browser, live realtime log, functions runner, API docs. | `/studio` |
| **Client SDK** | A `supabase-js`-style TypeScript client. | `@kobedb/client` |

> Built because cloning `supabase/supabase` was blocked by network policy — so this is a clean-room implementation of the same ideas.

## Architecture

```
                ┌──────────────────────────────────────────┐
   Browser /    │            @kobedb/server (Fastify)        │
   Client SDK ──┤  /auth  /rest  /storage  /realtime  /studio│
                └───────┬───────────────┬───────────────┬────┘
                        │ SQL           │ LISTEN/NOTIFY  │ fs
                  ┌─────▼─────┐   ┌──────▼──────┐  ┌──────▼──────┐
                  │ PostgreSQL│   │  realtime    │  │ storage-data│
                  │ (auth,    │   │  fan-out     │  │  (objects)  │
                  │  storage, │   └──────────────┘  └─────────────┘
                  │  public)  │
                  └───────────┘
```

Everything runs as **one Node process** plus **one Postgres instance** — easy to host anywhere.

## Quick start

```bash
# 1. Start Postgres (schema auto-loads from db/init on first run)
npm run db:up

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env        # edit JWT_SECRET / SERVICE_ROLE_KEY for production

# 4. Run the server (dev mode, hot reload)
npm run dev
```

Then open:

- **Studio dashboard** → http://localhost:8000/studio
- **API root** → http://localhost:8000/
- **Health** → http://localhost:8000/health

### Run everything in Docker

```bash
docker compose up --build      # Postgres + server together
```

## API examples

```bash
# Sign up (returns access_token + refresh_token)
curl -X POST http://localhost:8000/auth/v1/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"secret123"}'

# The sample `todos` table has RLS enabled with owner-scoped policies, so reads
# and writes require a user token — and each user only sees their own rows.
curl 'http://localhost:8000/rest/v1/todos?order=created_at.desc' \
  -H "Authorization: Bearer $TOKEN"

# Insert — the owner (user_id) is set automatically from your token.
curl -X POST http://localhost:8000/rest/v1/todos \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"Ship KobeDB"}'

# Invoke an edge function
curl -X POST http://localhost:8000/functions/v1/hello -d '{"name":"Kobe"}'
```

## Row-Level Security

Tables can be governed by a policy engine so callers only touch rows they're allowed to.
The sample `todos` table ships with owner-scoped policies. Manage policies via the
service-role admin API (or the **Policies** tab in Studio):

```bash
# Enable RLS on a table
curl -X POST http://localhost:8000/admin/rls -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' -d '{"table":"notes","enabled":true}'

# Add an owner-scoped read policy: authenticated users see only rows where user_id = their uid
curl -X POST http://localhost:8000/admin/policies -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"table":"notes","action":"select","roles":["authenticated"],"owner_column":"user_id"}'
```

- Tables **without** RLS keep the default: open reads, authenticated writes.
- Tables **with** RLS only permit operations allowed by a matching policy.
- `owner_column` scopes reads/updates/deletes to `column = auth.uid` and forces it on insert.
- `columns` restricts **which columns** a role may read or write (per-column RLS); omit it for all columns.
- The **service role** bypasses all policies.

### Per-column policies

Restrict sensitive columns by adding a `columns` allow-list to a policy:

```bash
# Users may read only id + nickname (never ssn), and may write only nickname
curl -X POST http://localhost:8000/admin/policies -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"table":"profiles","action":"select","roles":["authenticated"],"columns":["id","nickname"]}'
curl -X POST http://localhost:8000/admin/policies -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"table":"profiles","action":"insert","roles":["authenticated"],"columns":["nickname"]}'
```

Reading `select=*` returns only permitted columns; explicitly requesting a forbidden column (or writing one) returns `403`.

## Passwordless & OAuth login

```bash
# Magic link — emails a one-time sign-in link via the configured provider
curl -X POST http://localhost:8000/auth/v1/magiclink -d '{"email":"me@example.com"}'

# OAuth — set GOOGLE_/GITHUB_CLIENT_ID+SECRET, then redirect the browser to:
#   http://localhost:8000/auth/v1/authorize?provider=github&redirect_to=<app-url>
# After consent, KobeDB issues its own session and redirects back with tokens in the URL fragment.
```

### Email delivery

Magic-link emails are sent through a pluggable provider, selected with `EMAIL_PROVIDER`:

| `EMAIL_PROVIDER` | Behaviour | Config |
| --- | --- | --- |
| `log` (default) | Prints the link to the server console and returns it in the API response — zero setup for local dev. | — |
| `smtp` | Sends via any SMTP server (Gmail, SendGrid SMTP, Mailgun, Postmark…). Uses `nodemailer` (optional dep). | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` |
| `resend` | Sends via the [Resend](https://resend.com) HTTP API. | `RESEND_API_KEY`, `EMAIL_FROM` |

When a real provider (`smtp`/`resend`) is configured, the raw link is **not** returned in the API response — it only arrives by email.

## Edge Functions

Drop a handler at `functions/<name>/index.mjs`:

```js
export default async (request) => {
  const { name = 'world' } = await request.json().catch(() => ({}));
  return new Response(JSON.stringify({ hello: name }), {
    headers: { 'content-type': 'application/json' },
  });
};
```

Invoke it at `POST /functions/v1/<name>`. Each call runs isolated with a timeout.
If the `deno` binary is installed, KobeDB runs the function in a **Deno isolate** with
OS-enforced permissions (`--allow-net`, scoped `--allow-read`); otherwise it falls back
to a Node **worker thread**. Force a runtime with `FUNCTIONS_RUNTIME=deno|worker` (default `auto`).

## Schema designer & migrations

Manage your database structure over the service-role API (or the **Schema Designer** and
**SQL Editor** tabs in Studio):

```bash
# Create a table (an identity `id` PK is added automatically if you don't declare one)
curl -X POST http://localhost:8000/admin/schema/tables -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"notes","columns":[{"name":"body","type":"text","nullable":false},{"name":"pinned","type":"boolean","default":"false"}]}'

# Add a column
curl -X POST http://localhost:8000/admin/schema/tables/notes/columns -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' -d '{"name":"color","type":"text"}'

# Introspect the schema, or run any SQL migration
curl http://localhost:8000/admin/schema -H "Authorization: Bearer $SERVICE_ROLE_KEY"
curl -X POST http://localhost:8000/admin/sql -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' -d '{"query":"create index on public.notes (pinned)"}'
```

Column types are whitelisted and identifiers validated; the REST API and RLS engine pick
up new tables immediately.

## Backups & restore

KobeDB backs up with PostgreSQL's own tools (`pg_dump` custom format, restored via
`pg_restore`), so restores are transactional and portable. Manage them over the
service-role API or the **Backups** tab in Studio:

```bash
# Create a backup (writes a timestamped .dump to BACKUP_DIR)
curl -X POST http://localhost:8000/admin/backups -H "Authorization: Bearer $SERVICE_ROLE_KEY"

# List / download / restore / delete
curl http://localhost:8000/admin/backups -H "Authorization: Bearer $SERVICE_ROLE_KEY"
curl -OJ http://localhost:8000/admin/backups/<file>/download -H "Authorization: Bearer $SERVICE_ROLE_KEY"
curl -X POST http://localhost:8000/admin/backups/<file>/restore -H "Authorization: Bearer $SERVICE_ROLE_KEY"
```

The client tools (`postgresql-client`) must be installed on the server — the Docker
image includes them; the API returns `501` if they're missing.

## S3 / object storage backends

Storage defaults to the local filesystem. To use any S3-compatible service, set:

```bash
STORAGE_BACKEND=s3
S3_BUCKET=my-bucket
S3_REGION=us-east-1
S3_ENDPOINT=            # e.g. https://<account>.r2.cloudflarestorage.com for R2 / MinIO URL
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

Object metadata always lives in Postgres; only the raw bytes move to S3. The `@aws-sdk/client-s3`
package is an optional dependency, loaded lazily only when `STORAGE_BACKEND=s3`.

## Using the client SDK

```ts
import { createClient } from '@kobedb/client';

const db = createClient('http://localhost:8000');

await db.auth.signUp('a@b.com', 'secret123');
// or: await db.auth.signInWithOtp('a@b.com');            // magic link
// or: db.auth.signInWithOAuth('github', location.href);  // OAuth redirect

const { data } = await db.from('todos').select().eq('done', false).order('created_at', 'desc').get();

await db.from('todos').insert({ title: 'Hello from the SDK' }); // user_id set by RLS

db.channel('todos').on('*', (e) => console.log('change:', e)).subscribe();

const { data: fn } = await db.functions.invoke('hello', { body: { name: 'Kobe' } });
```

## Enable realtime on your own tables

Realtime works on any table that has the change trigger. Add it with the helper:

```sql
select public.kobedb_enable_realtime('public', 'my_table');
```

## Project layout

```
kobedb/
├── docker-compose.yml         # Postgres + server
├── db/init/                   # schema, sample data, RLS policies (auto-loaded)
├── functions/                 # edge functions (<name>/index.mjs)
│   └── hello/index.mjs
├── packages/
│   ├── server/                # Fastify API
│   │   └── src/
│   │       ├── auth/          # password, magic link, OAuth, JWT sessions
│   │       ├── rest/          # auto REST + RLS policy engine + schema/DDL admin API
│   │       ├── storage/       # buckets & objects (local + S3 drivers)
│   │       ├── realtime/      # LISTEN/NOTIFY → WebSocket fan-out
│   │       ├── functions/     # edge functions (Deno isolate + worker fallback)
│   │       └── studio/        # zero-build dashboard (static HTML/JS)
│   └── client/                # @kobedb/client TypeScript SDK
└── .env.example
```

## Security notes

- Change `JWT_SECRET` and `SERVICE_ROLE_KEY` before deploying.
- The auto REST API allows open **reads**; **writes** require an authenticated user or the service-role key. Tighten this per-table for production (e.g. add ownership checks / row filters).
- All identifiers are validated and all values are parameterized to prevent SQL injection.

## Roadmap

- ✅ Per-table / per-row access policies (RLS-style rules engine)
- ✅ OAuth providers & magic links
- ✅ Edge functions runtime (Deno isolate + worker-thread fallback)
- ✅ S3-compatible storage backend option
- ✅ Studio: schema designer & SQL migrations
- ✅ Email provider integration for magic links (log / SMTP / Resend)
- ✅ Database backups & restore (`pg_dump` / `pg_restore`)
- ✅ Per-column RLS
- Point-in-time restore (WAL archiving)
- Richer policy expressions (arbitrary SQL predicates)

## License

MIT
