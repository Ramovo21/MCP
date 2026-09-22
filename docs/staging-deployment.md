# V1.2 staging deployment

The repository contains deployable artifacts. **No public deployment has been made by this task:** a hosting account, two DNS names, a Supabase cloud project and Google OAuth consent are still required. Local verification is recorded separately in [the report](v1.2-staging-report.md).

## Architecture

```text
Internet HTTPS → Caddy → Next.js dashboard
                      → Gateway /mcp and management API
                            → private authenticated HTTP Worker
                                  → one child process per job → external provider
Gateway + Worker → Supabase PostgreSQL (tenant RLS)
Dashboard + Gateway → Supabase Auth
Gateway + Worker + child → OTLP Collector → Jaeger
```

Only Caddy publishes ports 80/443. Worker and Collector have no host ports. Jaeger listens on host loopback only; use an SSH tunnel. Docker Compose is a single-host deployment; the same images and worker protocol can run in Azure Container Apps, Kubernetes or other container services. `WorkerExecutor` is the seam for a future queue transport. A job carries execution/trace IDs; durable database claims remain authoritative. Do not retry ambiguous writes or interpret HTTP delivery as exactly-once external effects.

## Provisioning and configuration

1. Prepare a Linux Docker host with Compose, outbound HTTPS/PostgreSQL, and DNS records for `WEB_DOMAIN` and `GATEWAY_DOMAIN`. Allow inbound 80/443 for ACME and application access. Obtain approval before creating billable resources.
2. Create a separate Supabase cloud project. Configure Auth site URL and redirect allowlist for the HTTPS dashboard. Use a direct or session-mode PostgreSQL connection with certificate verification, not an undocumented local database. The application needs its gateway role grants and migrations; cloud role creation must be verified on that project. Never disable TLS certificate verification to work around connectivity.
3. On the deployment host, copy `config/staging.env.example` to `.local/staging.env` and fill it via an editor or secret manager. Generate independent random values for `MASTER_KEY` (32 bytes, base64) and `WORKER_AUTH_TOKEN` (at least 32 characters). The Supabase anon/publishable key is public; service-role keys and database passwords must never be in web build arguments.
4. Apply migrations using Supabase CLI with the connection supplied through the protected environment. `db:migrate` remains local-only. For cloud use the explicit command below; it is additive. Review a database backup first. Do not run `db:reset` against cloud.

```sh
pnpm install --frozen-lockfile
# DATABASE_URL supplied by your secure shell environment, not copied into source.
pnpm exec supabase db push --db-url "$DATABASE_URL" --dry-run
pnpm exec supabase db push --db-url "$DATABASE_URL"
docker compose --env-file .local/staging.env -f docker/compose.staging.yml config --quiet
docker compose --env-file .local/staging.env -f docker/compose.staging.yml up -d --build
docker compose --env-file .local/staging.env -f docker/compose.staging.yml ps
curl --fail https://YOUR_GATEWAY_DOMAIN/health
curl --fail https://YOUR_GATEWAY_DOMAIN/ready
```

PowerShell uses `$env:DATABASE_URL` in place of `$DATABASE_URL`. Avoid printing resolved `docker compose config` without `--quiet`, shell tracing, or container environment dumps: those expose secrets. Next.js public settings are baked into its image; rebuild the web image when these change.

Use separate Supabase projects, domains, OAuth clients and encryption keys for development, test, staging and production. Examples are under `config/`. `APP_ENV` is independent of `NODE_ENV`: a staging Next.js build still runs with `NODE_ENV=production`. Staging/production Gateway startup requires HTTPS public origins, an explicit host allowlist and a remote worker. Required configuration failures identify variable names without echoing values.

## Secrets

Existing tenant/connection AES-256-GCM encryption remains supported. `SecretProvider` adds asynchronous `getSecret`, `setSecret`, `deleteSecret` methods. `EnvironmentSecretProvider` is for environment injection/testing; its writes affect that instance's environment only. `LocalEncryptedSecretProvider(directory, key)` uses authenticated per-key encryption, atomic file replacement and restrictive file modes. On Windows, apply directory ACLs too. Keep its bootstrap key outside that directory; it cannot solve its own root-of-trust problem.

Set `SECRET_PROVIDER_MODULE` to a deployment-controlled module exporting a provider instance. Gateway loads its configured encryption/database/worker/OAuth secrets at startup; Worker loads only database/worker secrets through that interface. Never allow tenants to choose executable provider modules. For Azure Key Vault, AWS Secrets Manager or GCP Secret Manager, implement these three methods using workload identity, namespace keys per environment, restrict identity permissions, normalize errors and audit key access at the provider. Cloud SDKs and authentication stay inside the adapter. Actual cloud adapters and key rotation orchestration are not shipped or verified here. Restart services after injected secret changes; retain old master keys until data has been re-encrypted and backups accounted for.

## Google Workspace consent

Create an OAuth **Web application** client in your Google project. Enable only the Gmail, Drive and Calendar APIs you intend to use. Configure the consent screen, add staging test users, and add the exact authorized redirect URI:

```text
https://YOUR_GATEWAY_DOMAIN/oauth/callback/google-workspace
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the protected staging environment and restart Gateway. In Connections, create Google Workspace, select services (Gmail alone is the default), name the connection with an account label, then use **Connect / reconnect Google**. Consent returns to Connections. Discover and publish only desired tools. **Test** updates recorded connection health. Revoke Google access disables local authorization first, then revokes at Google; retry if provider revocation fails. A connection name is an operator-supplied label, not a verified Google identity claim.

The selected scopes are Gmail `gmail.readonly` (Gmail's `q` search cannot use `gmail.metadata`), Drive `drive.metadata.readonly`, and Calendar `calendar.events.readonly`. No send/write or file-content scope is requested. Gmail read-only is a restricted scope; Google app verification/security assessment requirements and test-user token expiry may apply before wider deployment. Review the [official Gmail list documentation](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth) and [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server).

Authorization state and PKCE verifiers are single-use, encrypted and bound to membership/tenant/connection generation. Access and refresh tokens remain encrypted in the database; OAuth requests do not run inside a worker and client secrets are not sent to connector children. A 401 marks the current authorization as requiring reconnect. A 403 requires operator attention to API access/scopes; 429/5xx are classified as transient. No blind OAuth refresh retry is performed. The UI never reveals saved tokens.

## Operations and limitations

`/health` is liveness; Gateway `/ready` checks required database columns and Worker readiness. Worker `/ready` requires its service bearer token and verifies the execution schema. An outage returns 503 with sanitized metadata. Do not use public liveness as proof of OAuth provider health; use the explicit connection test.

The private worker token grants execution-service authority. Keep worker ingress private and use HTTPS/mTLS if crossing hosts; plain HTTP is intended only on a trusted local Docker network. Child processes isolate crashes, not malicious plugins: deployment modules are trusted and currently receive a database credential capable of assuming the tenant role. Before production, use least-privilege database identities and OS/container egress controls. Jaeger uses ephemeral local storage; configure retention, authentication, backups and alerts before relying on it operationally. Pin/scanning container digests, HA, distributed rate limits/capacity, backup restore drills and cloud/provider approval remain deployment responsibilities.

For a new staging workspace, sign up through Supabase-backed UI, create an organization and add Demo CRM through Connections. The local `db:seed` script creates local demo credentials and is **not** a production account provisioning flow. Follow [MCP verification](staging-mcp-verification.md) after HTTPS is working.
