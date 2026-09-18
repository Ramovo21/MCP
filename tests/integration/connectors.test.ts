import { test, expect } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fixture } from '../helpers/fixture.js';
import { ConnectionService } from '../../apps/gateway/src/connections.js';
import { openApiConnector } from '../../connectors/openapi/src/index.js';
import { remoteMcpConnector } from '../../connectors/remote-mcp/src/index.js';
import {
  webhookConnector,
  signature,
  verifySignature,
} from '../../connectors/webhook/src/index.js';
import { SafeHttp } from '../../packages/shared/src/http.js';
import { createApp } from '../../apps/gateway/src/app.js';
import { PostgresRateLimiter } from '../../apps/gateway/src/rate-limit.js';
import { buildSearch } from '../../connectors/postgres/src/index.js';

test('selected OpenAPI operations execute against a real HTTP fixture and redirects are refused', async () => {
  const f = await fixture();
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const url = `http://127.0.0.1:${address.port}`,
    http = new SafeHttp({ privateHosts: ['127.0.0.1'], allowHttp: true });
  try {
    f.registry.register(openApiConnector(http));
    const service = new ConnectionService(f.db, f.vault, f.registry);
    const connection = await service.create(f.principal, {
      name: 'HTTP fixture',
      connectorId: 'openapi',
      secrets: {},
      config: {
        baseUrl: url,
        namespace: 'company',
        spec: {
          openapi: '3.1.0',
          paths: {
            '/customers/{id}': {
              get: {
                operationId: 'customer.get',
                parameters: [
                  { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                ],
              },
              delete: { operationId: 'customer.delete' },
            },
          },
        },
      },
    });
    expect(await service.discover(f.principal, connection.id)).toHaveLength(2);
    await service.import(f.principal, connection.id, ['company.customer.get']);
    expect(
      (await f.execution.list(f.principal)).some((t) => t.name === 'company.customer.delete'),
    ).toBe(false);
    const result = await f.execution.call(f.principal, 'company.customer.get', { id: 'abc' });
    expect(result.result).toEqual({ path: '/customers/abc' });
    await expect(http.fetch(url + '/redirect')).rejects.toThrow(/redirects/);
  } finally {
    server.close();
    await once(server, 'close');
    await f.db.close();
  }
});
test('remote MCP discovery and execution use the real SDK and upstream HTTP server', async () => {
  const f = await fixture();
  const server = createApp({
    execution: f.execution,
    auth: f.auth,
    rateLimiter: new PostgresRateLimiter(f.db),
    webOrigin: 'http://localhost:3000',
    hosts: ['127.0.0.1'],
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('address');
  try {
    const connector = remoteMcpConnector(
        new SafeHttp({ privateHosts: ['127.0.0.1'], allowHttp: true }),
      ),
      ctx = await new ConnectionService(f.db, f.vault, f.registry).context(
        f.principal,
        f.connection,
      );
    ctx.connection = {
      ...ctx.connection,
      connector_id: 'remote-mcp',
      config: { url: `http://127.0.0.1:${a.port}/mcp`, namespace: 'upstream' },
    };
    ctx.secrets = { bearerToken: f.key };
    const tools = await connector.discover(ctx);
    expect(tools[0]?.risk).toBe('CRITICAL');
    const result = await connector.execute(
      {
        ...(await f.execution.list(f.principal))[0]!,
        name: 'upstream.demo.crm.customer.search',
        config: { upstreamName: 'demo.crm.customer.search' },
      },
      {},
      ctx,
    );
    expect(JSON.stringify(result)).toContain('Ada Nguyen');
  } finally {
    server.close();
    await once(server, 'close');
    await f.db.close();
  }
});
test('webhook ingress verifies signatures, rejects replay, and outbound signs exact bytes', async () => {
  const f = await fixture(),
    secret = 's'.repeat(32);
  f.registry.register(webhookConnector());
  const service = new ConnectionService(f.db, f.vault, f.registry),
    connection = await service.create(f.principal, {
      name: 'Events',
      connectorId: 'webhook',
      config: { inbound: true },
      secrets: { signingSecret: secret },
    });
  const server = createApp({
    execution: f.execution,
    auth: f.auth,
    connections: service,
    rateLimiter: new PostgresRateLimiter(f.db),
    webOrigin: 'http://localhost:3000',
    hosts: ['127.0.0.1'],
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('address');
  try {
    const url = `http://127.0.0.1:${a.port}/webhooks/${connection.id}`,
      body = JSON.stringify({ event: 'created' }),
      timestamp = String(Math.floor(Date.now() / 1000)),
      headers = {
        'content-type': 'application/json',
        'x-omni-timestamp': timestamp,
        'x-omni-signature': 'sha256=' + signature(secret, timestamp, body),
      };
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(202);
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(409);
    expect(
      (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
        .status,
    ).toBe(401);
    verifySignature(secret, timestamp, headers['x-omni-signature'], Buffer.from(body));
    expect((await f.db.system.query('select * from webhook_events')).rows).toHaveLength(1);
  } finally {
    server.close();
    await once(server, 'close');
    await f.db.close();
  }
});
test('PostgreSQL generated queries run in PostgreSQL with projection and injection resistance', async () => {
  const f = await fixture();
  try {
    const q = buildSearch(
      { schema: 'public', table: 'demo_customers', columns: ['id', 'name'] },
      { filters: { name: "x' OR 1=1 --" } },
    );
    expect((await f.db.system.query(q.text, q.values)).rows).toHaveLength(0);
    const search = buildSearch(
      { schema: 'public', table: 'demo_customers', columns: ['name'] },
      { filters: { name: 'Ada Nguyen' } },
    );
    expect((await f.db.system.query(search.text, search.values)).rows).toEqual([
      { name: 'Ada Nguyen' },
    ]);
    await f.db.raw.exec('begin read only');
    await expect(
      f.db.raw.query(
        "insert into demo_customers(organization_id,name,email,company) values($1,'Forbidden','','')",
        [f.org],
      ),
    ).rejects.toThrow(/read-only/);
    await f.db.raw.exec('rollback');
  } finally {
    await f.db.close();
  }
});
