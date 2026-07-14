import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { verifyAccessToken, type AccessClaims } from './jwt.js';

export interface AuthContext {
  userId: string | null;
  role: string; // 'anon' | 'authenticated' | 'service_role'
  claims: AccessClaims | null;
}

/**
 * Resolve the caller's identity from either:
 *  - Authorization: Bearer <jwt>          (a logged-in user)
 *  - Authorization: Bearer <service-key>  (trusted server-side, full access)
 *  - apikey: <service-key>                (Supabase-style header)
 *  - nothing                              (anonymous)
 */
export function resolveAuth(req: FastifyRequest): AuthContext {
  const header = req.headers['authorization'];
  const apikey = (req.headers['apikey'] as string | undefined) ?? undefined;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = bearer ?? apikey;

  if (token && token === config.serviceRoleKey) {
    return { userId: null, role: 'service_role', claims: null };
  }

  if (bearer) {
    try {
      const claims = verifyAccessToken(bearer);
      return { userId: claims.sub, role: claims.role || 'authenticated', claims };
    } catch {
      // fall through to anon on invalid/expired token
    }
  }

  return { userId: null, role: 'anon', claims: null };
}

export function requireUser(ctx: AuthContext): asserts ctx is AuthContext & { userId: string } {
  if (!ctx.userId && ctx.role !== 'service_role') {
    throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  }
}
