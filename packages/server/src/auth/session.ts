import { query } from '../db.js';
import { signAccessToken, newRefreshToken } from './jwt.js';
import { config } from '../config.js';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  role: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export function publicUser(u: UserRow) {
  return { id: u.id, email: u.email, role: u.role, metadata: u.metadata, created_at: u.created_at };
}

export async function issueSession(user: UserRow) {
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

/** Find a user by email, or create one (used by magic-link / OAuth first sign-in). */
export async function upsertUserByEmail(
  email: string,
  metadata: Record<string, unknown> = {},
): Promise<UserRow> {
  const existing = await query<UserRow>(`select * from auth.users where email = $1`, [email]);
  if (existing.rows.length) return existing.rows[0];
  const { rows } = await query<UserRow>(
    `insert into auth.users (email, metadata, email_confirmed_at)
     values ($1, $2, now()) returning *`,
    [email, metadata],
  );
  return rows[0];
}
