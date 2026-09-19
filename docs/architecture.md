# Architecture

```mermaid
flowchart LR
  C[AI client / Console] --> A[Bearer auth + tenant + rate limit]
  A --> R[Tenant tool registry + permissions]
  R --> P[Risk + organization policy]
  P -->|approval required| H[Durable approval request]
  H -->|human approves + atomic claim| D[Revalidate principal / tool / policy]
  P -->|automatic + durable claim| D
  D --> W[Connector worker]
  W --> I[Installed connector]
  I --> X[API / PostgreSQL / MCP / webhook / Demo CRM]
  W --> E[Execution steps + metadata + audit]
```

The console is a Supabase-authenticated client. Membership resolution happens in the gateway; browser-supplied organization IDs do not confer access. Scoped API keys bind to one organization and an explicit list of tool names, and cannot administer organizations or approve requests.

`PostgresDatabase.tenant()` begins a transaction, assumes the non-superuser `omnimcp_gateway` role, and sets a transaction-local organization UUID. RLS enforces that UUID independently of explicit organization predicates in SQL. Tenant-owned references use composite `(organization_id, id)` foreign keys. The narrowly used system connection resolves verified membership, hashes for API-key authentication, installed connectors, webhook connection identity, and rate buckets.

The MCP core accepts a `GatewayDispatcher` interface and has no dependency on a specific connector or application service. It constructs an official SDK server for each request via `createMcpHandler`, rejects legacy protocol traffic, and maps the caller's allowed registry rows to `tools/list`. MCP and manual calls use the same execution service.

Execution arguments are encrypted while pending/running and bound to the tenant and execution UUID with AEAD. Only redacted arguments are available to the console; raw results are returned to the immediate caller and are not stored in logs. Durable result metadata contains only type/size. A retry with the same idempotency key returns the recorded status/metadata, not the original raw result.

Approval decisions lock the approval and execution in one transaction. Exactly one transition from pending to running succeeds. Rejected/expired requests erase their encrypted arguments and cannot dispatch. The original principal, current key revocation/membership, connection/tool enablement, permissions, schema and current approval requirement are rechecked before dispatch. CRITICAL always needs approval, regardless of organization policy.

External side effects and PostgreSQL commits are not a distributed transaction. A crash after upstream success can leave an ambiguous result. The gateway never automatically retries it. `executions:reconcile` marks stale running claims unknown and expires pending approvals. The upstream receives an execution-derived idempotency key where the protocol supports it; custom connectors must preserve that key. An operator reconciles unknown outcomes before a new request.

V1 workers run in the gateway process. Connector modules are deployment-trusted code, with access to narrowly constructed context and credentials. The dispatch boundary can be replaced with a durable queue and isolated worker pool later. Browser automation has a reserved SDK interface but no implementation or registry entry.

The console polls every 15 seconds for approval/execution changes. Supabase Realtime is deliberately not required by the correctness model; no public changefeed includes credential or argument ciphertext.
