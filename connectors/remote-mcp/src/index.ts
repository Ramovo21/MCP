import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { Connector, ConnectorContext } from '../../../packages/connector-sdk/src/index.js';
import { AppError } from '../../../packages/shared/src/index.js';
import { SafeHttp } from '../../../packages/shared/src/http.js';
const config = z
  .object({
    url: z.url(),
    namespace: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
    protocol: z.enum(['modern', 'auto']).default('modern'),
  })
  .strict();
export function remoteMcpConnector(http = new SafeHttp()): Connector {
  async function withClient<T>(
    ctx: ConnectorContext,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const c = config.parse(ctx.connection.config),
      target = new URL(c.url);
    const client = new Client(
      { name: 'OmniMCP-upstream', version: '0.1.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: c.protocol === 'modern' ? { pin: '2026-07-28' } : 'auto' },
      },
    );
    const transport = new StreamableHTTPClientTransport(target, {
      requestInit: {
        headers: {
          ...(ctx.secrets.bearerToken
            ? { Authorization: `Bearer ${ctx.secrets.bearerToken}` }
            : {}),
        },
      },
      fetch: async (input, init) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(input);
        if (url.origin !== target.origin)
          throw new AppError('SSRF_BLOCKED', 'Upstream origin changed');
        return http.fetch(url, { ...init, signal: ctx.signal });
      },
    });
    try {
      await client.connect(transport);
      return await fn(client);
    } finally {
      await client.close();
    }
  }
  return {
    id: 'remote-mcp',
    name: 'Remote MCP',
    version: '1.0.0',
    async discover(ctx) {
      return withClient(ctx, async (client) => {
        const c = config.parse(ctx.connection.config),
          tools = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          tools.push(...page.tools);
          cursor = page.nextCursor;
          if (tools.length > 500)
            throw new AppError('TOO_MANY_TOOLS', 'Upstream tool limit exceeded');
        } while (cursor);
        return tools.map((t) => ({
          namespace: c.namespace,
          name: t.name.replace(/[^a-zA-Z0-9_.-]/g, '_'),
          description: t.description ?? `Call upstream tool ${t.name}`,
          inputSchema: t.inputSchema,
          risk: 'CRITICAL' as const,
          config: { upstreamName: t.name },
        }));
      });
    },
    async execute(tool, args, ctx) {
      return withClient(ctx, (client) =>
        client.callTool(
          {
            name: String(tool.config.upstreamName),
            arguments: args,
            _meta: { 'omnimcp/idempotencyKey': ctx.executionId },
          },
          { timeout: 20000 },
        ),
      );
    },
  };
}
