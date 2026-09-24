# Integrating another project

OmniMCP is an action gateway: a client sees only tools its verified organization,
role and scopes permit. Execution always passes policy, durable recording,
approval when required, worker dispatch and audit. Connectors are deployed code,
not user-uploaded executable code.

## Composition

`apps/gateway/src/framework.ts` exports `createOmniMCP(OmniMCPConfig)`.
The production entry point uses the same factory as the runnable
[simple project](../examples/simple-project/README.md).

```ts
const services = await createOmniMCP({
  database,
  worker, // ProcessExecutor or private HttpWorkerExecutor
  authProvider, // verifies bearer identity
  tenantResolver, // optional; defaults to PostgresTenantResolver
  secretProvider, // must provide MASTER_KEY; no generated fallback
  executionStore, // optional; defaults to PostgresExecutionStore
});
```

Provide a `RateLimiter`, exact allowed hosts/origin and readiness callback when
mounting these services with `createApp`. Startup validates adapters, encryption
configuration and connector catalog before the caller opens a listening socket.
The factory never falls back to in-process connector execution.

The catalog comes from the **worker**, not a gateway-side array of executable
handlers. Deploy connector ESM modules via `CONNECTOR_MODULES` to both worker
discovery and execution. This preserves process isolation when moving from local
child processes to a private service or future queue/container executor.

## Identity and tenancy

`AuthProvider.getUser(token)` verifies tokens and returns a stable user ID.
`SupabaseAuthProvider` remains the default. An Auth0/Firebase/custom JWT adapter
must verify signature, issuer, audience and expiry; decoding JWT claims is not
verification. Such provider-specific implementations are not bundled.

`TenantResolver.fromUser` checks membership of a verified identity.
`fromApiKey` checks the key hash, revocation, scopes and organization binding.
`refresh` rechecks the original actor before delayed approval dispatch. Never
accept a browser-supplied organization or role as proof of authorization.
The PostgreSQL adapter stores hashes only and updates key last-use timestamps.

## Execution and audit storage

`packages/shared/src/storage.ts` defines semantic `ExecutionStore` and
`ExecutionTransaction` operations. Execution and approval decisions do not issue
SQL. `PostgresExecutionStore` implements them in the existing RLS-scoped database
transaction; `PostgresAuditStore` writes audit rows in that transaction.

An alternative store must provide all of these properties:

- Tenant scoping on every operation, including tool/connection lookup and audit.
- Atomic unique `(organization, idempotency key)` creation with conflict handling.
- Locked approval/execution reads and atomic approval-to-running transition.
- Rollback of execution/approval changes when audit persistence fails.
- Encrypted arguments, erasure on terminal states and immutable principal binding.
- Durable worker claims and no blind retry of ambiguous WRITE outcomes.

To change audit encoding in the default PostgreSQL store, supply
`auditStore: AuditStore<Sql>`. A custom execution store owns its transaction's
`audit()` implementation; supplying both is rejected to prevent split transactions.

**Scope of portability:** the supplied SaaS management UI/routes, OAuth database
adapter, rate limiter and default child worker claim implementation still use
PostgreSQL/Supabase schema. A non-PostgreSQL execution store needs a matching
`WorkerExecutor` with durable claims, and its own management adapters. This release
does not claim a ready-to-run Firebase-only SaaS. MCP transport needs no edits.

## Secrets and connectors

`SecretProvider` handles deployment secrets (environment, encrypted local file,
or a deployment-managed custom provider); `SecretVault` handles tenant-bound
authenticated encryption. Neither is a browser dependency. Production config
remains explicit; plaintext connection secrets are never returned after saving.

Implement `Connector`, validate schemas and risk, honor `context.signal`, use
`SafeHttp`, and forward `context.executionId` to upstream idempotency. See
[SDK](connector-sdk.md) and [contract harness](../packages/connector-sdk/src/testing.ts).
The worker validates discovered names/configuration/input and bounded JSON output,
scrubs credential values and sanitizes errors. Output schemas are optional contract
checks; they are not yet persisted or advertised as MCP `outputSchema`.

## Verification

```sh
pnpm verify
pnpm db:start
pnpm env:local
pnpm db:migrate
pnpm db:seed
pnpm test:connectors
pnpm test:live
pnpm test:audit
pnpm example:simple
# another terminal
pnpm example:verify
```

Keep a dedicated development database. The live/audit suites create disposable
tenants and databases; never point them at production. CI uses only local fixtures,
local Supabase and generated credentials, never a real Google account.
