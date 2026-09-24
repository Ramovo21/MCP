# Connector SDK

Custom integrations are deployment-trusted modules. No gateway-core changes are required to add one.

```ts
import { defineConnector } from '@omnimcp/connector-sdk';

export default defineConnector({
  id: 'inventory',
  name: 'Inventory',
  version: '1.0.0',
  tools: [
    {
      namespace: 'inventory.item',
      name: 'get',
      description: 'Retrieve stock information for one SKU.',
      risk: 'READ',
      inputSchema: {
        type: 'object',
        properties: { sku: { type: 'string', minLength: 1, maxLength: 80 } },
        required: ['sku'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        // Call your API through the shared SafeHttp helper.
        // context.secrets contains decrypted credentials only for this connection.
        // Forward context.executionId for upstream idempotency.
        // Honor context.signal. Return JSON-serializable data.
        return { sku: args.sku };
      },
    },
  ],
});
```

Compile the module for Node ESM and add its module URL to `CONNECTOR_MODULES`, for example `file:///opt/omnimcp/plugins/inventory/index.js`. Its default export must implement `Connector`. Keep SDK dependencies version-aligned with the deployed gateway. Local workspace packages export TypeScript source for development; built artifacts are emitted under the root `dist/` tree.

For dynamic tools, implement `Connector` directly:

- `id`, `name`, `version`: stable deployment metadata.
- `discover(context)`: return metadata and JSON schemas; discovery must not perform a user action or write to an upstream service.
- `execute(tool, args, context)`: implement the selected registry tool. This method is invoked only by the gateway's worker after a durable execution claim.
- Optional `test(context)`: read-only health/credential check.
- Optional `initialize(context)`: tenant-local setup when an administrator creates a connection; do not trigger upstream user actions. Demo CRM uses this to create sample data.

The context contains the verified tenant, connection configuration, decrypted per-connection secret dictionary, execution UUID, database adapter and abort signal. `database.tenant()` scopes local data access. Custom code is trusted, not a sandbox: review and deploy it like gateway code.

Names are `namespace.name` (for example `crm.customer.get`), never generic unqualified verbs. Describe semantics, side effects, expected identifiers, and bounds. Use `additionalProperties: false`, explicit lengths/limits, and `writeOnly: true` for sensitive input fields. Baseline risk is a minimum: administrators can raise it, not lower it. Upstream MCP annotations are not security authority.

Add behavioral connector tests, error/timeout cases and tenant/secret handling checks. Never log input secrets, authorization headers or raw upstream errors. Use `AppError` only for sanitized messages. Never introduce an arbitrary SQL tool or direct browser-to-connector execution route. Browser automation remains an unimplemented `BrowserAutomationExtension` boundary in V1.

V1.1 runs deployed modules in disposable Node processes for discovery, tests and execution. Do not rely on module-global mutable state surviving between calls. Return JSON-serializable bounded values, respect the AbortSignal, and pass the execution UUID to upstream idempotency mechanisms. See [worker boundary](worker-boundary.md) and [execution semantics](execution-semantics.md). Provider-neutral OAuth adapters are documented separately in [OAuth](oauth.md).

## V1.3 contract

Run `pnpm test:connectors` after local Supabase setup. It runs six real connector
implementations with local upstream fixtures; PostgreSQL uses a disposable real
database. Google is a fixture, not evidence of real Google consent.

`packages/connector-sdk/src/testing.ts` exports a runner-independent harness:

```ts
await testConnectorContract(connector, {
  context, // local upstream, tenant, secrets, database, executionId, AbortSignal
  toolName: 'inventory.item.get',
  arguments: { sku: 'example' },
  assertResult: (result) => assert.deepEqual(result, expected),
  assertIdempotency: (executionId) => assert.equal(receivedHeader, executionId),
});
```

The harness checks metadata, names, schemas, risks, discovery, successful bounded
JSON, semantic output, unknown tools, pre-aborted calls, tenant binding and
credential scrubbing. Idempotency assertions apply only to connectors whose
upstream supports it. Boundary tests additionally check deadlines, AbortSignal,
error sanitization, duplicate definitions and oversized/invalid output. Existing
security/audit tests cover process termination and ambiguous writes.

`ToolDefinition.outputSchema` optionally validates an object result inside the
worker. It is not yet part of persisted registry metadata or MCP advertisement.
Dynamic connector `config` must exactly match its current discovered operation;
raise a tool's baseline risk or change config by revoking/reimporting the tool.
An AbortSignal race bounds waiting only; disposable processes provide hard stops.
Neither mechanism proves that an external write was rolled back.

See [simple-project](../examples/simple-project/README.md) for a plugin that calls
a separate backend, including READ/WRITE/CRITICAL tools and upstream idempotency.
