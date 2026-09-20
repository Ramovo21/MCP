# Public staging MCP verification

**Public HTTPS and real Google consent have not been verified in this environment.** These commands are the exact operator procedure once hosting and OAuth authorization are supplied. Local equivalent checks passed through the real Inspector and separate HTTP Worker; see [the V1.2 report](v1.2-staging-report.md).

MCP 2026-07-28 uses modern discovery (`server/discover`), not the old `initialize` exchange. Installed Inspector 2.7.0 negotiates it automatically with `--protocol-era modern`; its one-shot `--method server/discover` is unsupported. Do not describe a legacy initialization test as a pass. The transport implementation was not changed in V1.2.

Create an organization-bound API key in the dashboard with only the Demo CRM and selected Google READ tools. Store it in the current shell environment without committing it. PowerShell commands:

```powershell
$env:OMNIMCP_ENDPOINT = 'https://YOUR_GATEWAY_DOMAIN/mcp'
# Set OMNIMCP_API_KEY securely in your terminal; do not paste it into a shared transcript.
Invoke-WebRequest 'https://YOUR_GATEWAY_DOMAIN/ready'
pnpm inspect $env:OMNIMCP_ENDPOINT --protocol-era modern --format json --method tools/list --header "Authorization: Bearer $env:OMNIMCP_API_KEY"
pnpm inspect $env:OMNIMCP_ENDPOINT --protocol-era modern --format json --method tools/call --tool-name demo.crm.customer.search --tool-args-json '{}' --header "Authorization: Bearer $env:OMNIMCP_API_KEY"
pnpm inspect $env:OMNIMCP_ENDPOINT --protocol-era modern --format json --method tools/call --tool-name google.gmail.email.search --tool-args-json '{"query":"invoice","limit":5}' --header "Authorization: Bearer $env:OMNIMCP_API_KEY"
```

For Bash use `"$OMNIMCP_ENDPOINT"` and `"Authorization: Bearer $OMNIMCP_API_KEY"`. CLI headers appear in the local process argument list; run on a trusted workstation. A scoped API key already identifies its organization, so no organization header is needed. Supabase user sessions must additionally supply `X-Organization-Id` for a verified membership.

Google must first be authorized through Connections and its selected tools published. Check the call returns `status: succeeded`, record its execution/trace ID and inspect the execution detail/audit entry. Do not copy real email results into Git or CI artifacts. Verify revocation causes subsequent calls to fail; disabling a tool must remove it from discovery. Reconnect through the UI rather than editing database token rows.

## External AI client

Configure any client supporting remote Streamable HTTP and this MCP protocol version with the endpoint above and a bearer header. There is no dependency on OpenAI or a particular model. Use an organization-scoped key limited to required READ tools. Ask: **Find my latest emails containing invoice.** Expected tool selection: `google.gmail.email.search` with `query: "invoice"`; use returned message IDs with `google.gmail.email.get` only when more detail is needed. The agent's decision does not bypass Gateway permissions or policy.

Client configuration syntax varies; endpoint, transport and authorization requirements are the protocol contract. Do not invent a client-specific configuration without checking that client's current documentation. This external-client conversation has not yet been run against a public deployment.

## Reproducible local proof

```sh
pnpm db:start
pnpm env:local
pnpm db:migrate
pnpm db:seed
docker compose -f docker/compose.telemetry.yml up -d
pnpm build
pnpm test:staging:local
```

The script launches compiled Gateway/Worker on temporary ports, signs into real local Supabase, invokes Inspector through the actual endpoint, verifies Collector/Jaeger traces, restarts Gateway/Worker, breaks and restores only its own PostgreSQL proxy, and verifies malformed-request handling and log secrecy. This is local evidence, not public Internet evidence.
