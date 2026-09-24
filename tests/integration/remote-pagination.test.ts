import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { remoteMcpConnector } from '../../connectors/remote-mcp/src/index.js';
import { SafeHttp } from '../../packages/shared/src/http.js';
import { fixture } from '../helpers/fixture.js';
import { ConnectionService } from '../../apps/gateway/src/connections.js';
test.each([false, true])(
  'remote MCP handles opaque empty cursors and rejects loops (loop=%s)',
  async (loop) => {
    const f = await fixture();
    let pages = 0;
    const handler = createMcpHandler(
      async () => {
        const s = new Server(
          { name: 'pagination', version: '1.0.0' },
          { capabilities: { tools: {} }, supportedProtocolVersions: ['2026-07-28'] },
        );
        s.setRequestHandler('tools/list', async (req) => {
          pages++;
          return {
            tools: [
              {
                name: req.params?.cursor === undefined ? 'first' : 'second',
                description: 'Page fixture.',
                inputSchema: { type: 'object' },
              },
            ],
            ...(req.params?.cursor === undefined || loop ? { nextCursor: '' } : {}),
          };
        });
        return s;
      },
      { legacy: 'reject' },
    );
    const server = createServer(toNodeHandler(handler)).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const a = server.address();
    if (!a || typeof a === 'string') throw Error('No address');
    try {
      const ctx = await new ConnectionService(f.db, f.vault, f.registry).context(
        f.principal,
        f.connection,
      );
      ctx.connection.config = { namespace: 'upstream', url: `http://127.0.0.1:${a.port}` };
      const connector = remoteMcpConnector(
        new SafeHttp({ privateHosts: ['127.0.0.1'], allowHttp: true }),
      );
      if (loop)
        await expect(connector.discover(ctx)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
      else expect((await connector.discover(ctx)).map((t) => t.name)).toEqual(['first', 'second']);
      expect(pages).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await handler.close();
      await f.db.close();
    }
  },
);
