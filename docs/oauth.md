# Provider-neutral OAuth framework

`packages/connector-sdk/src/oauth.ts` exposes `OAuthProvider` and a generic HTTPS authorization-code adapter. Providers configure authorization/token/revocation endpoints, client credentials and allowed scopes at deployment time. No Google-specific logic or provider credentials are shipped. `OAUTH_PROVIDER_MODULES` loads reviewed ES modules exporting an adapter; `OAUTH_REDIRECT_BASE` must equal the registered public HTTPS Gateway origin in production.

An authenticated human administrator POSTs `/api/connections/:id/oauth` with `{ "provider": "adapter-id", "scopes": ["read"] }`. Gateway checks membership and connection ownership, creates 256-bit random state and S256 PKCE, stores only the state hash plus an encrypted verifier, and returns an authorization URL. The provider redirects to `/oauth/callback/:provider?state=...&code=...`. State is valid for ten minutes, bound to tenant, user, connection and provider, and atomically consumed. The callback rechecks current membership and active connection. The callback returns connection status only, never tokens. A product-specific consent UI is not included in this architecture work.

Access/refresh tokens are AES-GCM encrypted with tenant/connection associated data in `oauth_tokens`; expiry and granted scopes are stored separately. Browser/PostgREST access has no policy. On execution the Gateway retrieves or refreshes the access token and passes only that access token to the connection worker as `bearerToken`. Refresh tokens stay in Gateway storage.

Refresh first commits a durable `refreshing` claim. Concurrent requests wait for its result; they do not reuse the same rotating refresh token. On failure the connection requires reauthorization. A Gateway crash after claiming leaves refresh pending and requires reconnecting; it never guesses that reusing an old refresh token is safe. Provider tokens/diagnostics are not included in errors or audit logs. Provider adapters must implement bounded network calls; the bundled generic adapter uses SSRF-safe bounded HTTP.

DELETE `/api/connections/:id/oauth` immediately disables local use, invalidates pending states and advances the authorization generation, then requests provider revocation. An already-exchanging older callback cannot reconnect afterward. Provider revocation failure remains visible and can be retried. Revoking the entire connection also blocks pending callbacks and local token use; separately revoke the OAuth grant to revoke it at the provider.

Automated tests use a fixture adapter to verify state/PKCE binding, one-time callback, encryption, allowed scopes, concurrent rotation, revocation and ambiguous refresh handling. No real external provider consent has been performed. Provider registration, credentials, actual scopes and provider-specific token behavior remain deployment work.

Design reference: [OAuth 2.0 Security BCP, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).
