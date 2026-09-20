# Security model

## Tenant and authorization boundaries

Supabase `getUser(token)` validates user access tokens. The gateway independently resolves organization membership and role. An organization UUID is a selector, never authorization. API keys contain 256 random bits, are stored as SHA-256 hashes only, have explicit tool-name scopes, update last-used time, and become unusable immediately when revoked. Their roles cannot be owner/admin.

The gateway uses explicit organization predicates plus PostgreSQL RLS under a `NOLOGIN NOBYPASSRLS` role. Composite foreign keys prevent cross-tenant references. V1.1 removes direct browser policies for management/discovery tables so PostgREST cannot bypass Gateway tool permissions. The browser reads organizations for its switcher; tools, connections and governance data are served through Gateway. Credentials, API hashes, encrypted arguments, OAuth tokens and webhook payloads have no browser policy. Onboarding is a narrowly scoped security-definer function with an empty search path and an authenticated user requirement. Membership changes are owner-only; administration and human approvals reject API keys.

The configured backend login has privileged membership/authentication lookup access. The trusted worker runtime currently receives this credential for SDK-backed storage and execution claims; clients never receive it. Use a dedicated protected backend credential and restrict network access. Process isolation protects Gateway availability, not against a malicious plugin with the same filesystem identity or database credential. Untrusted plugins require narrower storage capabilities and container identities before production use.

## Secrets and logging

`SecretVault` abstracts AES-256-GCM authenticated encryption. Each ciphertext uses a fresh 96-bit nonce, a version marker, and tenant/record associated data. `MASTER_KEY` must decode to 32 cryptographically random bytes, remain server-side, and be backed up separately from the database. The abstraction can be replaced by a managed KMS envelope implementation; the synchronous local contract can be wrapped by a preloaded data-key provider. Rotation requires decrypt/re-encrypt with the old/new key; do not simply replace the environment variable.

Credential ciphertext is kept in a separate RLS-protected table and deleted on connection revocation. Pending/running arguments are encrypted; terminal executions erase their argument ciphertext. Redaction masks credential/PII-related keys and schema `writeOnly` fields. Result storage includes size/type only, not raw output. HTTP logger events contain fixed error codes/statuses, not request headers, bodies, URLs or error stacks. Connector authors remain responsible for classifying custom sensitive fields.

## Execution and approvals

READ can run automatically. WRITE requires approval unless enabled by policy. SENSITIVE/CRITICAL require explicit permission; CRITICAL always requires human approval. Approval requests bind to immutable encrypted arguments and the original principal, expire after 24 hours, and are claimed with row locks in one transaction. An idempotency key is unique within a tenant and binds to principal, tool and canonical arguments. Changed arguments with a reused key fail. Concurrent decisions cannot dispatch twice. Revoked principals, disabled connections/tools and changed policy are rechecked.

There is no general exactly-once guarantee across external services and gateway crashes. Upstream idempotency is required for that guarantee. Unknown outcomes are never automatically retried. Reconciliation requires checking the upstream side effect before issuing a new request.

## Network and database safety

HTTP connectors allow HTTPS, reject embedded credentials, disallow redirects, inspect all resolved IPs, and pin the checked address into the socket lookup while retaining TLS SNI. Non-public IP ranges, IPv4-mapped IPv6, metadata/link-local destinations are rejected; exact private-host exceptions require deployment administration. Calls have bounded duration and 2 MiB response limits. Provider errors are sanitized.

PostgreSQL uses a checked/pinned destination, verified TLS by default, selected identifiers, explicit projections, parameterized values, row limits and statement timeouts. Reads run inside `BEGIN READ ONLY`. Inserts require explicit `allowWrites` configuration and tool selection. Use a dedicated least-privilege upstream database login. Schema/table/column selections are revalidated during discovery. No raw SQL tool exists.

Webhook signatures authenticate exact raw bytes with HMAC-SHA256, constant-time comparison and a five-minute clock window. A unique tenant/connection/signature-material hash rejects replay. Inbound events are encrypted and acknowledged; they cannot bypass execution policy.

The gateway validates Host and browser Origin, defaults to no wildcard CORS, and supports no cookie-based API authentication, avoiding ambient-cookie CSRF. Supabase tokens are held by its browser client; XSS remains a concern, so the console uses React text rendering, no raw HTML injection, and security headers. Add deployment-specific CSP, TLS/HSTS, WAF and infrastructure egress rules before internet exposure.

## Production controls still required

Managed key storage and rotation, backups/PITR, dependency updates, structured-log collection and alerting, hardened backend DB credentials, TLS and hostname configuration, tenant quotas/retention, production email confirmation and recovery, isolated workers for untrusted integrations, and external security review. Local `.env`, seed credentials, and private-host exceptions must never become production defaults.
