# Verification evidence

Verified locally on **2026-09-19**, using Node **24.18.0**, pnpm **10.32.1**, official MCP server/client/node packages **2.0.0**, Inspector **2.7.0**, and local Supabase CLI **2.117.0** / PostgreSQL **17**.

| Check                      | Observed result                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                | Passed                                                                                                              |
| `pnpm typecheck`           | Passed; strict TypeScript, web and backend                                                                          |
| `pnpm test`                | 9 tests passed                                                                                                      |
| `pnpm test:integration`    | 14 tests passed across 9 files                                                                                      |
| `pnpm test:live`           | Passed against real Supabase Auth/PostgREST/RLS and TCP PostgreSQL                                                  |
| `pnpm build`               | Passed; gateway JS/declarations and all 11 management sections                                                      |
| `pnpm test:e2e`            | 2 Chromium tests passed against production-built apps                                                               |
| `pnpm test:inspector:live` | Official Inspector listed tools and called a Demo CRM READ tool against the production gateway                      |
| Inspector integration      | Official CLI listed tools, called READ, and received pending approval for a CRITICAL tool                           |
| Container recipes          | Both Linux images built; gateway health + authenticated Inspector list/call passed; web dashboard returned HTTP 200 |
| `pnpm audit --prod`        | No known vulnerabilities reported                                                                                   |

Behavioral coverage includes local migration application, RLS under a non-superuser tenant role, actual authenticated Supabase isolation, API-key creation/scopes/revocation, cross-tenant mutation denial, input rejection, READ execution, WRITE and CRITICAL approvals, self-approval denial, concurrent approval claims, rejection/expiry/revocation without execution, idempotency conflicts, SQL parameterization/read-only transactions, selected OpenAPI import and HTTP execution, remote MCP discovery/execution through the official client, signed inbound/outbound webhooks and replay rejection, exact-origin CORS, DNS/IP restrictions, real pinned socket lookup, response-size bounds, authenticated encryption context binding, redacted traces, shared rate counters, and immutable audit insertion.

The live PostgreSQL approval test races two independent pool transactions and verifies one demo note. Browser tests sign in to real Supabase, call a tool, visit all management areas, check mobile overflow, switch organizations, verify selection survives navigation, and verify sign-out clears workspace data. The screenshots in ignored `.local/` are local verification artifacts, not fake product data.

No externally paid API or optional LLM provider was called. OpenAPI, webhook and upstream MCP behavior is verified against real local HTTP fixtures; production provider-specific OAuth/compatibility still requires that provider's credentials. CI workflow files were created and their commands run locally; no remote GitHub Actions run or production deployment was performed. Container image smoke tests are not a substitute for deployment/load/restore testing.

Non-blocking build warning: Next.js 15 reports that its optional ESLint plugin is not installed. Repository ESLint, strict TypeScript and production builds pass independently.
