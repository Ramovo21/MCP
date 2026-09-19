import { test, expect } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fixture } from '../helpers/fixture.js';
import { webhookConnector, verifySignature } from '../../connectors/webhook/src/index.js';
import { SafeHttp } from '../../packages/shared/src/http.js';
import { ConnectionService } from '../../apps/gateway/src/connections.js';
test('gateway dispatches a signed outbound webhook with stable idempotency', async () => {
  const f = await fixture(),
    secret = 'random-test-secret-'.repeat(3);
  let received: unknown,
    key: string | undefined,
    signatureValid = false;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    try {
      verifySignature(
        secret,
        String(req.headers['x-omni-timestamp']),
        String(req.headers['x-omni-signature']),
        body,
      );
      signatureValid = true;
      received = JSON.parse(body.toString());
      key = String(req.headers['idempotency-key']);
      res.setHeader('content-type', 'application/json');
      res.end('{"delivered":true}');
    } catch {
      res.writeHead(401);
      res.end();
    }
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('address');
  try {
    f.registry.register(
      webhookConnector(new SafeHttp({ privateHosts: ['127.0.0.1'], allowHttp: true })),
    );
    const connections = new ConnectionService(f.db, f.vault, f.registry),
      connection = await connections.create(f.principal, {
        name: 'Outbound fixture',
        connectorId: 'webhook',
        config: { url: `http://127.0.0.1:${address.port}`, namespace: 'events' },
        secrets: { signingSecret: secret },
      });
    await connections.import(f.principal, connection.id, ['events.send']);
    await f.db.system.query(
      'insert into approval_policies(organization_id,allow_write) values($1,true)',
      [f.org],
    );
    const result = await f.execution.call(f.principal, 'events.send', {
      event: 'customer.created',
      payload: { id: 1 },
    });
    expect(result.status).toBe('succeeded');
    expect(received).toEqual({ event: 'customer.created', payload: { id: 1 } });
    expect(signatureValid).toBe(true);
    expect(key).toBe(result.executionId);
  } finally {
    upstream.close();
    await once(upstream, 'close');
    await f.db.close();
  }
});
