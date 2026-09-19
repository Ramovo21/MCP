import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SafeHttp } from '../../packages/shared/src/http.js';
test('checked DNS is pinned into the actual socket and response bounds are enforced', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url === '/large') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(3 * 1024 * 1024));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ host: req.headers.host }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  let resolutions = 0;
  const client = new SafeHttp({ privateHosts: ['fixture.test'], allowHttp: true }, async () => {
    resolutions++;
    return [{ address: '127.0.0.1', family: 4 }];
  });
  try {
    expect(await client.json(`http://fixture.test:${address.port}`)).toEqual({
      host: `fixture.test:${address.port}`,
    });
    expect(resolutions).toBe(1);
    expect(requests).toBe(1);
    await expect(client.fetch(`http://fixture.test:${address.port}/large`)).rejects.toThrow(
      /exceeds|failed/,
    );
    await expect(new SafeHttp().fetch('http://example.com')).rejects.toThrow(/HTTPS/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
