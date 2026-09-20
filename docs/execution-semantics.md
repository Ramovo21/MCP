# Execution semantics

Authorization, schema validation and policy run before dispatch. Gateway stores a durable execution and encrypted immutable arguments. Approval is bound to the execution and requesting principal; only human administrators can decide it. A transaction locks both approval and execution. Dispatch rechecks membership/key revocation, enabled tools/connections and current policy. The worker atomically sets `worker_claimed_at` only on a running, unclaimed execution. Duplicate deliveries cannot execute the connector again.

| Classification             | Typical codes                                      | Retry policy                       |
| -------------------------- | -------------------------------------------------- | ---------------------------------- |
| validation_failure         | INVALID_ARGUMENTS, INVALID_SCHEMA                  | Fix input; do not retry unchanged  |
| permission_failure         | FORBIDDEN, SSRF_BLOCKED                            | Fix authorization/configuration    |
| approval_required          | APPROVAL_REQUIRED / pending status                 | Human decision required            |
| transient_upstream_failure | UPSTREAM_TRANSIENT (429/5xx), UPSTREAM_UNAVAILABLE | READ may be retried explicitly     |
| permanent_upstream_failure | UPSTREAM_PERMANENT, DATABASE_ERROR                 | Inspect cause before a new request |
| timeout                    | WORKER_TIMEOUT, WORKER_CANCELLED, UPSTREAM_TIMEOUT | READ may be retried explicitly     |
| connector_failure          | CONNECTOR_FAILURE                                  | READ may be retried explicitly     |

No automatic retry loop is enabled, including for READ. Error metadata provides `kind`, `retryable`, and `outcomeUnknown`; clients can decide whether to submit a new READ request. For writes, timeout, crash, connection loss, malformed/oversized response or upstream uncertainty may follow a committed side effect. These executions become `unknown`, and are never blindly retried.

An HTTP `Idempotency-Key` binds to organization, principal, tool name and canonical arguments. Reuse with different arguments or principal fails. Reuse with identical arguments returns the existing execution status and result metadata; it does not re-dispatch or persist raw results. MCP clients can provide this header on calls too.

OpenAPI and outbound webhook requests receive the stable execution UUID as `Idempotency-Key`. Remote MCP receives `omnimcp/idempotencyKey` in request metadata. These are **hints until the upstream documents and implements idempotency**. The Demo CRM note table has a unique tenant/execution constraint. PostgreSQL inserts are not advertised as idempotent.

Exactly-once _claim/dispatch under concurrent approval_ is tested. Exactly-once external effects across distributed crashes are not generally possible here. Run `pnpm executions:reconcile` to expire approvals and mark long-running executions unknown without retry. Inspect the upstream using the execution UUID before any replacement write.

Every execution has a random trace ID. Request, policy, approval, worker, connector and HTTP upstream stages are visible in Execution Detail. `traceparent` is propagated upstream; logs contain correlation metadata only. `TraceExporter` in `packages/shared/src/tracing.ts` is an adapter seam for OpenTelemetry. No OTel collector/exporter is enabled or claimed tested.
