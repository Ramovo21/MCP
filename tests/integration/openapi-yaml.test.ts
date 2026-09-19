import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture } from '../helpers/fixture.js';
import { SafeHttp } from '../../packages/shared/src/http.js';
import { openApiConnector } from '../../connectors/openapi/src/index.js';
import { ConnectionService } from '../../apps/gateway/src/connections.js';
test('OpenAPI specification URLs accept YAML and generate selected tools', async () => {
  const f = await fixture(),
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/yaml');
      res.end(
        'openapi: 3.1.0\npaths:\n  /items:\n    get:\n      operationId: item.search\n      summary: Search items\n',
      );
    }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  try {
    f.registry.register(
      openApiConnector(new SafeHttp({ privateHosts: ['127.0.0.1'], allowHttp: true })),
    );
    const service = new ConnectionService(f.db, f.vault, f.registry);
    const connection = await service.create(f.principal, {
      name: 'YAML API',
      connectorId: 'openapi',
      config: {
        namespace: 'catalog',
        baseUrl: `http://127.0.0.1:${address.port}`,
        specUrl: `http://127.0.0.1:${address.port}/schema.yaml`,
      },
      secrets: {},
    });
    const tools = await service.discover(f.principal, connection.id);
    expect(tools[0]?.fullName).toBe('catalog.item.search');
    expect(tools[0]?.risk).toBe('READ');
  } finally {
    server.close();
    await once(server, 'close');
    await f.db.close();
  }
});
