import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { issueSession, upsertUserByEmail, type UserRow } from './session.js';
import { getProvider, isConfigured, buildAuthUrl, providers } from './oauth.js';
import { sendMagicLinkEmail } from '../email/templates.js';
import { emailDeliversExternally } from '../email/provider.js';

// In-memory OAuth state store (state -> { provider, redirectTo, expiresAt }).
const stateStore = new Map<string, { provider: string; redirectTo: string; expiresAt: number }>();
function putState(provider: string, redirectTo: string): string {
  const state = crypto.randomBytes(16).toString('hex');
  stateStore.set(state, { provider, redirectTo, expiresAt: Date.now() + 10 * 60 * 1000 });
  return state;
}
function takeState(state: string) {
  const s = stateStore.get(state);
  if (s) stateStore.delete(state);
  if (!s || s.expiresAt < Date.now()) return null;
  return s;
}

export async function authExtraRoutes(app: FastifyInstance) {
  // ── Magic link (passwordless) ────────────────────────────────────────────
  // POST /auth/v1/magiclink { email, redirect_to? }
  // Emails a sign-in link via the configured provider. In 'log' mode the link is
  // also returned in the response for local development.
  app.post('/auth/v1/magiclink', async (req, reply) => {
    const { email, redirect_to } = (req.body ?? {}) as any;
    if (!email) return reply.code(400).send({ error: 'email required' });
    const user = await upsertUserByEmail(email);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await query(
      `insert into auth.one_time_tokens (token, user_id, type, expires_at) values ($1, $2, 'magiclink', $3)`,
      [token, user.id, expiresAt],
    );
    let action_link = `${config.publicUrl}/auth/v1/verify?token=${token}&type=magiclink`;
    if (redirect_to) action_link += `&redirect_to=${encodeURIComponent(redirect_to)}`;

    try {
      await sendMagicLinkEmail(email, action_link);
    } catch (err: any) {
      app.log.error({ err }, 'failed to send magic link email');
      return reply.code(502).send({ error: `failed to send email: ${err.message}` });
    }

    // Only expose the raw link when no external provider is configured (dev convenience).
    const body: Record<string, unknown> = { message: 'magic link sent', email };
    if (!emailDeliversExternally()) body.action_link = action_link;
    return reply.send(body);
  });

  // GET /auth/v1/verify?token=...&type=magiclink
  app.get('/auth/v1/verify', async (req, reply) => {
    const { token, redirect_to } = req.query as any;
    if (!token) return reply.code(400).send({ error: 'token required' });
    const { rows } = await query<any>(
      `select ott.*, u.* from auth.one_time_tokens ott
         join auth.users u on u.id = ott.user_id
        where ott.token = $1 and ott.used = false and ott.expires_at > now()`,
      [token],
    );
    if (!rows.length) return reply.code(401).send({ error: 'invalid or expired token' });
    await query(`update auth.one_time_tokens set used = true where token = $1`, [token]);
    const session = await issueSession(rows[0] as UserRow);
    if (redirect_to) {
      const url = `${redirect_to}#access_token=${session.access_token}&refresh_token=${session.refresh_token}`;
      return reply.redirect(url);
    }
    return reply.send(session);
  });

  // ── OAuth ────────────────────────────────────────────────────────────────
  // GET /auth/v1/authorize?provider=github&redirect_to=<url>
  app.get('/auth/v1/authorize', async (req, reply) => {
    const { provider: providerId, redirect_to } = req.query as any;
    const provider = getProvider(String(providerId ?? ''));
    if (!provider) return reply.code(400).send({ error: `unknown provider: ${providerId}` });
    if (!isConfigured(provider))
      return reply.code(400).send({ error: `provider ${provider.id} is not configured (set ${provider.id.toUpperCase()}_CLIENT_ID/SECRET)` });

    const state = putState(provider.id, redirect_to ?? config.publicUrl);
    const redirectUri = `${config.publicUrl}/auth/v1/callback`;
    return reply.redirect(buildAuthUrl(provider, redirectUri, state));
  });

  // GET /auth/v1/callback?code=...&state=...
  app.get('/auth/v1/callback', async (req, reply) => {
    const { code, state } = req.query as any;
    if (!code || !state) return reply.code(400).send({ error: 'code and state required' });
    const st = takeState(String(state));
    if (!st) return reply.code(400).send({ error: 'invalid or expired state' });

    const provider = getProvider(st.provider);
    if (!provider || !isConfigured(provider))
      return reply.code(400).send({ error: 'provider not configured' });

    const redirectUri = `${config.publicUrl}/auth/v1/callback`;

    // 1. Exchange the code for an access token.
    const tokenRes = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: provider.clientId!,
        client_secret: provider.clientSecret!,
        code: String(code),
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenJson: any = await tokenRes.json();
    const providerToken = tokenJson.access_token;
    if (!providerToken) return reply.code(400).send({ error: 'failed to obtain provider token', detail: tokenJson });

    // 2. Fetch the user's profile.
    const infoRes = await fetch(provider.userInfoUrl, {
      headers: { Authorization: `Bearer ${providerToken}`, Accept: 'application/json', 'User-Agent': 'KobeDB' },
    });
    const info: any = await infoRes.json();
    const { providerUid, email } = provider.mapUser(info);
    if (!email) return reply.code(400).send({ error: 'provider did not return an email' });

    // 3. Link identity + issue our own session.
    const user = await upsertUserByEmail(email, { provider: provider.id });
    await query(
      `insert into auth.identities (user_id, provider, provider_uid, identity_data)
       values ($1, $2, $3, $4)
       on conflict (provider, provider_uid) do update set identity_data = excluded.identity_data`,
      [user.id, provider.id, providerUid, info],
    );
    const session = await issueSession(user);

    const url = `${st.redirectTo}#access_token=${session.access_token}&refresh_token=${session.refresh_token}`;
    return reply.redirect(url);
  });

  // List which providers are available/configured (handy for building login UIs).
  app.get('/auth/v1/providers', async () => {
    return {
      magiclink: true,
      oauth: Object.values(providers).map((p) => ({ id: p.id, configured: isConfigured(p) })),
    };
  });
}
