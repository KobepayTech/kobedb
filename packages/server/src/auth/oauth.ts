// OAuth provider definitions. Configure via environment variables:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
// Providers with no configured client id are treated as "not configured".

export interface OAuthProvider {
  id: string;
  authUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
  clientId?: string;
  clientSecret?: string;
  // Map the provider's userinfo response to { providerUid, email }.
  mapUser: (info: any) => { providerUid: string; email: string };
}

export const providers: Record<string, OAuthProvider> = {
  google: {
    id: 'google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    mapUser: (info) => ({ providerUid: String(info.sub), email: info.email }),
  },
  github: {
    id: 'github',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    mapUser: (info) => ({ providerUid: String(info.id), email: info.email }),
  },
};

export function getProvider(id: string): OAuthProvider | null {
  return providers[id] ?? null;
}

export function isConfigured(p: OAuthProvider): boolean {
  return !!(p.clientId && p.clientSecret);
}

export function buildAuthUrl(p: OAuthProvider, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: p.clientId!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scope,
    state,
  });
  return `${p.authUrl}?${params.toString()}`;
}
