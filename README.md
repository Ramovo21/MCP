# OmniMCP

**Universal AI Integration & Action Gateway.** A multi-tenant tool registry, execution gateway, and management console for AI clients. Integrations are plugins; every user-triggered call passes through server-side authorization, policy, durable execution tracking, and human approval when required.

Uses MCP **2026-07-28**, official `@modelcontextprotocol/server`, `@modelcontextprotocol/client` and Node adapter **2.0.0**, Streamable HTTP, Node >=22.19, strict TypeScript, pnpm, Next.js, Tailwind, and Supabase Auth/PostgreSQL/RLS. No browser automation runs in V1.

## Run locally

Prerequisites: Node >=22.19, Docker Desktop/Engine running, and pnpm 10.32.1 (`npm install --global pnpm@10.32.1`). Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm db:start
pnpm env:local
pnpm db:seed
pnpm dev
```

`db:start` applies migrations to a new local Supabase database. To recreate the **local** database, `pnpm db:migrate` runs `supabase db reset`, deleting local data; seed again afterward. Do not use reset against a database whose data you need.

- Console: http://localhost:3000/dashboard
- Gateway health: http://localhost:4000/health
- MCP endpoint: http://localhost:4000/mcp
- Supabase Studio: http://127.0.0.1:54323

`env:local` creates an ignored `.env` using the running local Supabase stack, a random encryption master key, and a random seed password. It preserves existing `.env` files and never prints credentials. Sign in as **developer@omnimcp.local**, using `SEED_PASSWORD` from that file. There is no shared demo password. Three sample CRM customers and three tools are seeded. New Demo CRM connections also initialize tenant-local sample customers.

For an existing Supabase project, copy `.env.example` to `.env`, configure its values, and apply the SQL migration using your normal Supabase migration deployment process. The gateway database login must be able to `SET ROLE omnimcp_gateway`; see [security notes](docs/security.md).

## What is included

| Area          | Functionality                                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console       | Dashboard metrics, connections, tool registry/schema detail, MCP servers, approvals, executions/timelines, audit logs, Playground, API keys, members, policy/developer settings               |
| Gateway       | Supabase bearer/API-key authentication, organization resolution, permission-filtered discovery, strict inputs, RBAC, risk policies, approvals, idempotency, durable rate limiting, audit, MCP |
| Connectors    | Demo CRM, selected OpenAPI operations, allowlisted PostgreSQL reads/optional inserts, selected remote MCP tools, signed inbound/outbound webhooks                                             |
| Extensibility | Connector SDK, deployment-loaded custom modules, replaceable secret vault, rate limiter and worker boundary; browser extension interface only                                                 |
| Verification  | Unit, PostgreSQL/RLS integration, HTTP security, approval concurrency, official SDK/Inspector, live Supabase/PostgreSQL, Chromium end-to-end tests                                            |

The Playground works without an LLM. Optionally configure an OpenAI-compatible chat endpoint to propose a tool and arguments; the user reviews and invokes through the gateway. MCP has no dependency on an LLM provider.

## MCP Inspector

Create an API key in **API keys**, selecting `demo.crm.customer.search` and any other needed tools. Only the creation response reveals the key. Use the official CLI:

```sh
pnpm inspect http://localhost:4000/mcp --protocol-era modern --method tools/list --header "Authorization: Bearer <key>"
pnpm inspect http://localhost:4000/mcp --protocol-era modern --method tools/call --tool-name demo.crm.customer.search --tool-args-json '{}' --header "Authorization: Bearer <key>"
pnpm inspect http://localhost:4000/mcp --protocol-era modern --method tools/call --tool-name demo.crm.note.create --tool-args-json '{"customerId":"<customer-uuid>","body":"Follow up next week"}' --header "Authorization: Bearer <key>"
```

Use a customer UUID returned by search. WRITE requires approval by default. To test CRITICAL: raise the note tool's risk in Tool registry and explicitly **Allow developer** (API-key role), then call it with a key scoped to that tool. It returns `status: pending`; no note is written. Approve/reject in the console. API-key requests can be approved by a human administrator. Human requests require a different administrator unless the organization deliberately enables self-approval.

MCP 2026-07-28 removes initialization sessions; the Inspector needs `--protocol-era modern` because its ad-hoc CLI default is legacy. The automated test invokes the real Inspector executable for list, READ call, and approval-triggering call:

```sh
pnpm test:inspector
pnpm test:inspector:live     # running gateway + seeded local Supabase
```

## Tests and builds

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:live               # local Supabase + .env + seed
pnpm exec playwright install chromium
pnpm test:e2e                # gateway and console running
```

`pnpm verify` runs lint, types, unit/integration tests (including Inspector), and the production build. Fast integration tests apply the actual migration to PGlite, a PostgreSQL WASM runtime, and exercise RLS as a non-superuser. Live tests additionally verify real Supabase authentication/RLS, TCP PostgreSQL execution, and concurrent approval claims. HTTP upstream fixtures are confined to tests. No production service falls back to an in-memory database or fake authentication.

## Repository

```text
apps/web                   Next.js management console
apps/gateway               Authenticated REST + Streamable HTTP gateway
services/connector-worker  Trusted in-process dispatch boundary
packages/mcp-core         Official MCP transport/registry mapping and schema validation
packages/connector-sdk    Plugin contracts, registration, reserved extension interfaces
packages/policy-engine    Permission and risk decisions
packages/shared           Types, encryption, redaction, bounded SSRF-safe HTTP
packages/database         PostgreSQL tenant transactions and audit helpers
connectors/*              OpenAPI, PostgreSQL, remote MCP, webhooks, Demo CRM
supabase/migrations       Schema, composite tenant keys, RLS, onboarding RPC
tests                     Unit, integration, live and browser tests
scripts                   Local configuration, seed and reconciliation
docs                      Architecture, development, SDK, security and deployment
docker                    Gateway and web container recipes
```

See [architecture](docs/architecture.md), [local development](docs/local-development.md), [connector SDK](docs/connector-sdk.md), [security](docs/security.md), [deployment and limitations](docs/deployment.md), and [verification evidence](docs/verification.md).
