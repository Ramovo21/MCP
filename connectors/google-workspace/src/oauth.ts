import { oauthProvider } from '../../../packages/connector-sdk/src/oauth.js';
import { SafeHttp } from '../../../packages/shared/src/http.js';
import { googleScopes } from './index.js';

export function googleOAuthProvider(clientId: string, clientSecret: string, http = new SafeHttp()) {
  if (!clientId || !clientSecret)
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required together');
  const provider = oauthProvider(
    {
      id: 'google-workspace',
      clientId,
      clientSecret,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      revokeUrl: 'https://oauth2.googleapis.com/revoke',
      scopes: Object.values(googleScopes),
    },
    http,
  );
  const authorizationUrl = provider.authorizationUrl.bind(provider);
  provider.connectorIds = ['google-workspace'];
  provider.authorizationUrl = (input) => {
    const url = new URL(authorizationUrl(input));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    // Avoid incremental grants silently adding unrelated permissions from previous applications.
    url.searchParams.set('include_granted_scopes', 'false');
    return url.href;
  };
  return provider;
}
