# ⚡ KobeDB

A self-hostable, open-source backend platform — your own **Supabase-style stack**, built from scratch in TypeScript on top of PostgreSQL.

It bundles the pieces you need to ship an app without writing a backend:

| Pillar | What you get | Endpoint |
| --- | --- | --- |
| **Database + REST** | Auto-generated CRUD REST API over every table in your `public` schema, with PostgREST-style filters (`eq`, `gt`, `ilike`, `in`, `order`, `limit`, …). | `/rest/v1` |
| **Auth** | Email/password signup & login, JWT access tokens, rotating refresh tokens, service-role key, admin user listing. | `/auth/v1` |
| **Realtime** | WebSocket subscriptions to row changes (INSERT/UPDATE/DELETE) via Postgres `LISTEN/NOTIFY`. | `ws://…/realtime/v1` |
| **Storage** | S3-style buckets & objects backed by the local filesystem, public/private access rules. | `/storage/v1` |
| **Studio** | A zero-build web dashboard: table editor, query runner, auth manager, storage browser, live realtime log, API docs. | `/studio` |
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
# List todos (open read)
curl 'http://localhost:8000/rest/v1/todos?done=is.false&order=created_at.desc&limit=5'

# Sign up
curl -X POST http://localhost:8000/auth/v1/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"secret123"}'

# Insert (needs a Bearer token from signup/login)
curl -X POST http://localhost:8000/rest/v1/todos \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"Ship KobeDB"}'
```

## Using the client SDK

```ts
import { createClient } from '@kobedb/client';

const db = createClient('http://localhost:8000');

await db.auth.signUp('a@b.com', 'secret123');

const { data } = await db.from('todos').select().eq('done', false).order('created_at', 'desc').get();

await db.from('todos').insert({ title: 'Hello from the SDK' });

db.channel('todos').on('*', (e) => console.log('change:', e)).subscribe();
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
├── db/init/                   # schema + sample data (auto-loaded by Postgres)
├── packages/
│   ├── server/                # Fastify API: auth, rest, storage, realtime, studio
│   │   └── src/studio/        # zero-build dashboard (static HTML/JS)
│   └── client/                # @kobedb/client TypeScript SDK
└── .env.example
```

## Security notes

- Change `JWT_SECRET` and `SERVICE_ROLE_KEY` before deploying.
- The auto REST API allows open **reads**; **writes** require an authenticated user or the service-role key. Tighten this per-table for production (e.g. add ownership checks / row filters).
- All identifiers are validated and all values are parameterized to prevent SQL injection.

## Roadmap

- Per-table / per-row access policies (RLS-style rules engine)
- OAuth providers & magic links
- Edge functions (Deno) runtime
- S3-compatible storage backend option
- Studio: schema designer & migrations

## License

MIT
