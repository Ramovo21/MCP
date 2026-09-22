# OpenTelemetry in OmniMCP

V1.2 uses the official OpenTelemetry JS SDK with an OTLP HTTP exporter, not just an event callback. Instrumentation is explicit to avoid exporting HTTP URLs, query strings, authorization headers, request/response bodies or exception stacks. See [the official exporter documentation](https://opentelemetry.io/docs/languages/js/exporters/).

```sh
docker compose -f docker/compose.telemetry.yml up -d
```

Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces` in local service environments. Start Gateway and Worker normally. Open Jaeger at `http://127.0.0.1:16686` and search using the trace ID returned in an execution or `X-Trace-Id` response header. In staging this collector URL is `http://telemetry:4318/v1/traces` on the private Docker network; Jaeger is host-loopback only.

Spans include `mcp.request`/`gateway.request`, `gateway.authentication`, `gateway.policy`, `gateway.approval`, `gateway.dispatch`, `worker.job`, `connector.execute`, and `upstream.http`. Gateway uses server-generated trace IDs; it does not trust arbitrary Internet trace IDs. Private job envelopes carry parent span IDs. Executions persist trace/parent IDs so approval-resumed dispatch stays on the original execution trace. The approval HTTP request has its own request trace, with a span link to the original execution request and an execution ID attribute. Execution steps retain worker/connector/upstream events and the detail page exposes the execution trace ID.

Only allowlisted scalar metadata is exported: organization/execution ID, connector/tool name, method, operation, status, risk/decision and safe error codes. Attributes and events exclude tool arguments, results, credentials and provider exception text. Child processes flush spans before exiting normally; forcibly killed children may lose unfinished spans. The supervisor and failed execution still record the failure. Export queues and export timeouts are bounded; collector failure must not fail a tool call. HTTP upstream 4xx/5xx mark the upstream span as an error without exposing its response.

The local proof actually sends traces through Collector into Jaeger and asserts correlated spans and positive durations:

```sh
pnpm build
pnpm test:staging:local
```

This requires local Supabase and seed credentials, plus the telemetry Compose stack. It runs production bundles on temporary ports, leaves existing development services alone, and writes only nonsecret evidence to ignored `.local/v1.2-local-proof.json`. Unit tests also use the SDK's in-memory exporter to inspect parent IDs and verify redaction.

Jaeger/Collector are a development/staging diagnostic setup, not an HA observability platform. Add durable storage, access control, retention, sampling, metrics, alerts and collector resource limits appropriate to your hosting environment. Trace IDs and organization IDs are operational metadata and should still be treated as restricted information.
