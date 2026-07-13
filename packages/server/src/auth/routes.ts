import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { signAccessToken, newRefreshToken } from './jwt.js';
import { resolveAuth } from './middleware.js';
import { config } from '../config.js';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

function publicUser(u: UserRow) {
  return { id: u.id, email: u.email, role: u.role, metadata: u.metadata, created_at: u.created_at };
}

async function issueSession(user: UserRow) {
  const access_token = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const { token: refresh_token, expiresAt } = newRefreshToken();
  await query(
    `insert into auth.refresh_tokens (token, user_id, expires_at) values ($1, $2, $3)`,
    [refresh_token, user.id, expiresAt],
  );
  return {
    access_token,
    refresh_token,
    token_type: 'bearer',
    expires_in: config.jwtAccessTtl,
    user: publicUser(user),
  };
}

export async function authRoutes(app: FastifyInstance) {
  // POST /auth/v1/signup  { email, password, metadata? }
  app.post('/auth/v1/signup', async (req, reply) => {
    const { email, password, metadata } = (req.body ?? {}) as any;
    if (!email || !password) return reply.code(400).send({ error: 'email and password are required' });
    if (String(password).length < 6)
      return reply.code(400).send({ error: 'password must be at least 6 characters' });

    const exists = await query(`select 1 from auth.users where email = $1`, [email]);
    if (exists.rowCount) return reply.code(409).send({ error: 'user already exists' });

    const hash = await bcrypt.hash(String(password), 10);
    const { rows } = await query<UserRow>(
      `insert into auth.users (email, password_hash, metadata, email_confirmed_at)
       values ($1, $2, $3, now()) returning *`,
      [email, hash, metadata ?? {}],
    );
    return reply.code(201).send(await issueSession(rows[0]));
  });

  // POST /auth/v1/token?grant_type=password   { email, password }
  // POST /auth/v1/token?grant_type=refresh_token { refresh_token }
  app.post('/auth/v1/token', async (req, reply) => {
    const grant = (req.query as any)?.grant_type ?? 'password';

    if (grant === 'password') {
      const { email, password } = (req.body ?? {}) as any;
      if (!email || !password) return reply.code(400).send({ error: 'email and password required' });
      const { rows } = await query<UserRow>(`select * from auth.users where email = $1`, [email]);
      const user = rows[0];
      if (!user || !(await bcrypt.compare(String(password), user.password_hash)))
        return reply.code(400).send({ error: 'invalid login credentials' });
      return reply.send(await issueSession(user));
    }

    if (grant === 'refresh_token') {
      const { refresh_token } = (req.body ?? {}) as any;
      if (!refresh_token) return reply.code(400).send({ error: 'refresh_token required' });
      const { rows } = await query<any>(
        `select rt.*, u.* from auth.refresh_tokens rt
           join auth.users u on u.id = rt.user_id
          where rt.token = $1 and rt.revoked = false and rt.expires_at > now()`,
        [refresh_token],
      );
      if (!rows.length) return reply.code(401).send({ error: 'invalid refresh token' });
      // rotate: revoke old, issue new
      await query(`update auth.refresh_tokens set revoked = true where token = $1`, [refresh_token]);
      const user = rows[0] as UserRow;
      return reply.send(await issueSession(user));
    }

    return reply.code(400).send({ error: `unsupported grant_type: ${grant}` });
  });

  // GET /auth/v1/user  — current user from access token
  app.get('/auth/v1/user', async (req, reply) => {
    const ctx = resolveAuth(req);
    if (!ctx.userId) return reply.code(401).send({ error: 'not authenticated' });
    const { rows } = await query<UserRow>(`select * from auth.users where id = $1`, [ctx.userId]);
    if (!rows.length) return reply.code(404).send({ error: 'user not found' });
    return reply.send(publicUser(rows[0]));
  });

  // POST /auth/v1/logout  — revoke a refresh token
  app.post('/auth/v1/logout', async (req, reply) => {
    const { refresh_token } = (req.body ?? {}) as any;
    if (refresh_token) {
      await query(`update auth.refresh_tokens set revoked = true where token = $1`, [refresh_token]);
    }
    return reply.code(204).send();
  });

  // GET /auth/v1/admin/users — list users (service role only)
  app.get('/auth/v1/admin/users', async (req, reply) => {
    const ctx = resolveAuth(req);
    if (ctx.role !== 'service_role') return reply.code(403).send({ error: 'service role required' });
    const { rows } = await query<UserRow>(`select * from auth.users order by created_at desc limit 200`);
    return reply.send(rows.map(publicUser));
  });
}
