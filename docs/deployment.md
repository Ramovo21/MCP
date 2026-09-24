# Deployment and V1 boundaries

Build with `pnpm install --frozen-lockfile && pnpm verify`. Apply migrations before deploying gateway code. Configure Supabase Auth, backend PostgreSQL connectivity and `SET ROLE omnimcp_gateway` privileges, secrets, exact `WEB_ORIGIN` and `GATEWAY_HOSTS`. The web `NEXT_PUBLIC_*` variables are public and fixed at build time. Gateway secrets are runtime-only. Run `node dist/apps/gateway/src/main.js` behind an HTTPS proxy with a JSON request-body limit and at least a 35-second upstream timeout; run the Next.js production server separately.

Container recipes under `docker/` run as non-root. The gateway image compiles Node code; the web image enables `NEXT_STANDALONE=1` for Next.js standalone output. Normal local builds use the regular Next.js server, avoiding Windows symlink privilege requirements. Supply environment variables through the deployment's secret manager, never Docker build arguments for server secrets. Only public web settings are build arguments. See verification evidence for image-build and runtime checks.

Schedule `pnpm executions:reconcile` at least every minute on one worker. It expires stale approvals and marks running claims older than five minutes `unknown`. It never retries side effects. Configure database backups, retention and monitoring for `unknown`/`failed` statuses and pending-approval backlog. Keep the PostgreSQL rate limiter for shared counters across gateway instances, or implement the same interface against Redis.

## Known non-blocking V1 limitations

- Connector jobs execute in disposable Node processes with deadlines, cancellation and bounded concurrency. These processes share the Gateway OS identity and backend database credential: only trusted deployed plugins are supported. There is no distributed queue or sandbox for hostile code. See [worker boundary](worker-boundary.md).
- No managed vault adapter or automatic master-key rotation is shipped. AES-GCM local encryption is implemented behind a replaceable abstraction.
- No full SaaS billing, enterprise SSO, invitation-email delivery, or organization deletion flow. Owners add existing Supabase users by UUID; new users create an organization after sign-up.
- Remote MCP uses independent bearer credentials and the official SDK. Provider-neutral OAuth supports initiation/callback/encrypted-token/refresh/revocation; Google Workspace READ adapters are bundled, but real external consent and deployment credentials are still required. Every imported remote tool starts CRITICAL; metadata cannot reduce risk.
- OpenAPI supports 3.0/3.1, local acyclic references, JSON request bodies and ordinary path/query/header parameters. External/cyclic references, cookies, multipart, custom parameter serialization and provider-specific OAuth flows are rejected or require a custom connector. HEAD operations return status metadata; prefer GET for returned data.
- PostgreSQL supports selected `search`, `get`, and explicitly configured `insert`. The console exposes read selection; inserts require administrator API configuration. Updates/deletes/arbitrary SQL are not provided. Identifiers are limited to conventional alphanumeric/underscore SQL names.
- UI lists show the latest 100 executions/approvals/audit entries, with 15-second polling. Long-term pagination/export and Realtime subscriptions are future work.
- Raw tool results are intentionally not persisted. Idempotent replays return status and result metadata; an approved action's immediate result is returned to its approver. Agents can read the execution status through the authenticated REST endpoint; there is no MCP task extension subscription in V1.
- Native upstream exactly-once semantics depend on upstream idempotency. Crash ambiguity requires operator reconciliation; this is a distributed-systems boundary, not a guarantee the gateway can invent.
- Optional natural-language proposals require a configured compatible LLM service and may incur its usage costs. No provider is required or called by default.

Before production: perform infrastructure load/failure testing, restore tests, organization/RBAC security review, dependency auditing, secret rotation rehearsal, observability setup and independent penetration testing. A passing local test suite is not production deployment approval.
