import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

// Simple in-memory fixed-window rate limiter keyed by client IP + bucket.
interface Counter { count: number; resetAt: number; }
const buckets = new Map<string, Counter>();

function hit(key: string, max: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  let c = buckets.get(key);
  if (!c || c.resetAt <= now) {
    c = { count: 0, resetAt: now + windowMs };
    buckets.set(key, c);
  }
  c.count++;
  return { ok: c.count <= max, retryAfter: Math.ceil((c.resetAt - now) / 1000) };
}

// Periodically drop expired buckets so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, c] of buckets) if (c.resetAt <= now) buckets.delete(k);
}, 60_000).unref?.();

// Endpoints that authenticate credentials get a much stricter limit.
function isSensitive(url: string, method: string): boolean {
  if (method !== 'POST') return false;
  return (
    url.startsWith('/auth/v1/token') ||
    url.startsWith('/auth/v1/signup') ||
    url.startsWith('/auth/v1/magiclink')
  );
}

function clientIp(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.ip || 'unknown';
}

// Attach hooks directly to the root instance (NOT via app.register) so they apply
// globally — Fastify encapsulates hooks added inside a registered plugin.
export function registerSecurity(app: FastifyInstance) {
  // Baseline security response headers (kept compatible with the inline-script Studio UI).
  app.addHook('onRequest', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-permitted-cross-domain-policies', 'none');
  });

  if (!config.rateLimitEnabled) return;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const ip = clientIp(req);
    const url = req.url.split('?')[0];
    const sensitive = isSensitive(url, req.method);
    const max = sensitive ? config.rateLimitAuthMax : config.rateLimitMax;
    const key = `${sensitive ? 'auth' : 'gen'}:${ip}`;
    const { ok, retryAfter } = hit(key, max, config.rateLimitWindowMs);
    if (!ok) {
      reply.header('retry-after', String(retryAfter));
      return reply.code(429).send({ error: 'too many requests, slow down', retry_after: retryAfter });
    }
  });
}
