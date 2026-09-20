import { z } from 'zod';
import { AppError } from '../../shared/src/index.js';
import { SafeHttp } from '../../shared/src/http.js';
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
}
export interface OAuthProvider {
  id: string;
  scopes: readonly string[];
  authorizationUrl(input: {
    state: string;
    challenge: string;
    redirectUri: string;
    scopes: string[];
  }): string;
  exchange(input: { code: string; verifier: string; redirectUri: string }): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  revoke(token: string): Promise<void>;
}
export function oauthProvider(
  config: {
    id: string;
    clientId: string;
    clientSecret: string;
    authorizationUrl: string;
    tokenUrl: string;
    revokeUrl: string;
    scopes: string[];
  },
  http = new SafeHttp(),
): OAuthProvider {
  for (const endpoint of [config.authorizationUrl, config.tokenUrl, config.revokeUrl]) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
      throw new Error('OAuth endpoints must be deployment-configured HTTPS URLs');
  }
  const exchange = async (parameters: Record<string, string>): Promise<OAuthTokens> => {
    const response = await http.json(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...parameters,
      }).toString(),
    });
    const token = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().optional(),
        token_type: z.string(),
        expires_in: z.number().positive().max(31536000),
        scope: z.string().default(''),
      })
      .parse(response);
    if (token.token_type.toLowerCase() !== 'bearer')
      throw new AppError('INVALID_OAUTH_TOKEN', 'Unsupported OAuth token type');
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      scopes: token.scope.split(' ').filter(Boolean),
    };
  };
  return {
    id: config.id,
    scopes: config.scopes,
    authorizationUrl(input) {
      const url = new URL(config.authorizationUrl);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: input.redirectUri,
        state: input.state,
        code_challenge: input.challenge,
        code_challenge_method: 'S256',
        scope: input.scopes.join(' '),
      }).toString();
      return url.href;
    },
    exchange: ({ code, verifier, redirectUri }) =>
      exchange({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    refresh: (refreshToken) =>
      exchange({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async revoke(token) {
      const response = await http.fetch(config.revokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }).toString(),
      });
      if (!response.ok)
        throw new AppError('OAUTH_REVOKE_FAILED', 'Provider revocation failed', 502);
    },
  };
}
