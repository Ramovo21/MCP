# MCP conformance evidence (V1.3)

Target: **2026-07-28**, official split TypeScript server/client/node packages
**2.0.0**, Streamable HTTP. Modern requests carry the reserved `_meta` envelope
and matching headers. Discovery is `server/discover`; legacy `initialize` is
deliberately rejected. This is not a claim of 100% MCP conformance or SDK tier status.

Official references inspected before transport changes:

- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [createMcpHandler API](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/server/createMcpHandler.html)
- [Official conformance runner and requirement sets](https://github.com/modelcontextprotocol/conformance)

## Run

```sh
pnpm install --frozen-lockfile
pnpm test:conformance
```

No database or credentials are required. The loopback fixture imports the actual
`packages/mcp-core` HTTP handler and official SDK, with an in-memory dispatcher.
It does not disable production authentication. Additional synthetic diagnostic
tool names are required by the official runner and are never published by production.

The pinned official runner is `@modelcontextprotocol/conformance@0.2.0-alpha.11`.
The npm `latest` tag 0.1.16 uses the old SDK and does not cover the target revision;
the explicitly pinned alpha supports modern per-request metadata. This prerelease
test dependency does not replace production split SDK packages.

For each ephemeral fixture URL, the test executes the equivalent of:

```sh
pnpm exec conformance server --url http://127.0.0.1:<port>/mcp --scenario server-stateless --spec-version 2026-07-28
```

The other selected scenarios are `tools-list`, `tools-call-simple-text`,
`tools-call-error`, and `http-header-validation`. Any nonzero CLI exit fails CI;
there is no expected-failure baseline. Sanitized transcripts are regenerated under
ignored `.local/conformance/`. This is a selected tools-gateway profile, not the
full official `--requirements 2026-07-28` server/client suite.

## Coverage and capabilities

- Advertised capability: `tools`. Dynamic discovery is tenant/permission filtered.
- Official stateless checks exercise discovery, protocol version negotiation,
  mandatory metadata, optional clientInfo, header/body mismatch, unknown/removed
  methods, HTTP error mapping, request IDs and capability error mapping.
- Local tests assert schemas, structured tool results, invalid names/arguments,
  secret-safe errors, malformed JSON, 1 MiB request rejection, independent clients,
  legacy rejection and timeout cancellation reaching the server handler.
- The registry returns a complete list with no next cursor. Remote MCP ingestion
  honors opaque cursors (including empty strings) and rejects cursor loops.
- CRITICAL approval is a gateway outcome (`pending`), not an MCP task extension.
  Execution semantics and durable approval tests run in integration/live/audit.

Not advertised or implemented as product capabilities: resources, prompts,
completion, sampling/elicitation requests, tasks, subscriptions/list-change delivery,
progress streams or media-producing tools. The diagnostic missing-client-capability
fixture verifies SDK error mapping without adding a sampling workflow. The official
suite can mark conditional unsupported list-change checks SKIPPED; those are not passes.

Cancellation is best effort after dispatch: a terminated client/worker cannot undo
an upstream mutation. Ambiguous writes remain `unknown`, never automatically retried.
The selected conformance fixture is unauthenticated loopback-only; authentication,
RBAC, tenant isolation and approvals are separately checked against the real Gateway.

See [V1.3 report](v1.3-report.md) for final executed test counts and limitations.

Final local run: 10 Vitest cases passed. The five official scenarios reported
49 successful checks and zero failures; two conditional list-change checks were
SKIPPED because those capabilities are absent. No expected-failure baseline is used.
