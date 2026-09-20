# MCP verification commands (V1.1 audit)

The installed official packages are `@modelcontextprotocol/server`, `client` and `node` 2.0.0, and Inspector 2.7.0. Before changes, their installed APIs and [official protocol documentation](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions) were checked.

MCP 2026-07-28 is stateless: the SDK negotiates using `server/discover`; there is no legacy `initialize` handshake. Inspector 2.7.0 performs discovery when `--protocol-era modern` is supplied, but its one-shot `--method server/discover` command is unsupported. That command was tried, failed, and was corrected. We do not claim it passed.

## Complete real-server verification

```sh
pnpm install --frozen-lockfile
pnpm db:start
pnpm env:local
pnpm db:migrate
pnpm db:seed
pnpm test:audit
```

`test:audit` starts the normal Gateway entrypoint on 127.0.0.1:4100, with real Supabase authentication/PostgreSQL and private process workers. It creates temporary tenants, issues a real scoped API key, invokes the official Inspector executable, and cleans up its own fixtures. It refuses non-loopback database/Auth hosts. It needs a locally privileged database account to create its disposable upstream database, and OpenSSL for an ephemeral local HTTPS certificate (Git for Windows is auto-detected; alternatively set `AUDIT_OPENSSL`). `AUDIT_GATEWAY_PORT` can select another unused port; `AUDIT_ENV_FILE` selects an alternate local environment file.

The independently reproduced audit used the following PowerShell command against a separate Supabase project on ports 55321–55324:

```powershell
$env:AUDIT_ENV_FILE = '.local/audit-repro/.env'
.\node_modules\.bin\pnpm.cmd test:audit
```

The harness spawns the installed Inspector launcher with exactly these arguments (credentials below are placeholders; tests never print them):

```sh
node <inspector-package>/clients/launcher/build/index.js --cli http://127.0.0.1:4100/mcp --protocol-era modern --format json --header "Authorization: Bearer <temporary-key>" --method tools/list
node <inspector-package>/clients/launcher/build/index.js --cli http://127.0.0.1:4100/mcp --protocol-era modern --format json --header "Authorization: Bearer <temporary-key>" --method tools/call --tool-name demo.crm.customer.search --tool-args-json '{}'
node <inspector-package>/clients/launcher/build/index.js --cli http://127.0.0.1:4100/mcp --protocol-era modern --format json --header "Authorization: Bearer <temporary-key>" --method tools/call --tool-name demo.crm.note.create --tool-args-json '{"customerId":"<fixture-id>","body":"WRITE approval"}'
```

It then raises the note tool to CRITICAL through `/api/tools/:id`, grants explicit owner/developer permission, repeats Inspector calls and asserts pending approvals without side effects. Through the authenticated `/api/approvals/:id/decide` route it rejects one request, approves another with eight simultaneous clicks, checks exactly one successful decision and one database note, and verifies `tool.succeeded` audit data. An independent official SDK client additionally asserts `getProtocolEra() === 'modern'` after connection.

## Manual smoke against the normally running app

```sh
pnpm dev
# In another terminal:
pnpm test:inspector:live
pnpm inspect http://localhost:4000/mcp --protocol-era modern --method tools/list --header "Authorization: Bearer <key>"
pnpm inspect http://localhost:4000/mcp --protocol-era modern --method tools/call --tool-name demo.crm.customer.search --tool-args-json '{}' --header "Authorization: Bearer <key>"
```

The full audit also tests the same REST endpoint used by Playground, API-key calls and forged approval/risk/organization fields. Browser interaction itself is covered separately by `pnpm test:e2e`; those browser tests are not a substitute for the approval bypass checks.
