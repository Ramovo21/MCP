# Simple project: reuse OmniMCP locally

This example adds a deployment-trusted connector without editing MCP core. It runs
a loopback REST backend with customers, products and orders, a real Gateway and
disposable connector child processes. Gateway state uses your **local** migrated
Supabase PostgreSQL; no cloud or LLM account is needed.

From the repository root (Node >=22.19, pnpm 10.32.1, Docker running):

```sh
pnpm install --frozen-lockfile
pnpm db:start
pnpm env:local
pnpm db:migrate
pnpm example:simple
# In another terminal:
pnpm example:verify
```

MCP listens at `http://127.0.0.1:4200/mcp` (`EXAMPLE_PORT` overrides the port).
The backend binds a random loopback port. Temporary bearer credentials and the
organization UUID are written to ignored `.local/simple-project/session.json`.
Use `Authorization: Bearer <userToken>` and `X-Organization-Id: <organizationId>`
when configuring an MCP client. Never publish this file. Stop with Ctrl+C to close
workers and delete this run's organization, identities and credential file.
An abrupt OS termination may leave example rows; they are never reused by another run.

| Tool             | Risk     | Behavior                                               |
| ---------------- | -------- | ------------------------------------------------------ |
| `customer.get`   | READ     | Get `customer-1`                                       |
| `product.search` | READ     | Search Notebook and Keyboard                           |
| `order.create`   | WRITE    | Create an order; this example explicitly permits WRITE |
| `order.cancel`   | CRITICAL | Require a different human administrator's approval     |

`example:verify` uses the official v2 MCP client. It discovers all four tools,
reads customer/products, creates an order, requests cancellation, proves self
approval is forbidden, approves as the second identity, rejects a duplicate
approval and checks persisted worker tracing. The live test additionally checks
the backend mutation counts and database audit events:

```sh
pnpm exec vitest run tests/live/example.test.ts
```

`runtime.ts` demonstrates `createOmniMCP` with a small custom bearer identity
provider, PostgreSQL membership/storage and a generated AES-GCM key.
`connector.ts` is loaded exclusively through `CONNECTOR_MODULES` in the worker.
`backend.ts` checks a separate encrypted connection credential and deduplicates
mutations by execution ID. Its in-memory business data and receipt cache are for
this disposable demonstration only; production upstreams need durable storage.
The example rejects non-loopback databases and production mode. Its custom local
authentication and loopback HTTP allowance are not installed in the normal Gateway.
