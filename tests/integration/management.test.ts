import { test, expect } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fixture } from '../helpers/fixture.js';
import { ConnectionService } from '../../apps/gateway/src/connections.js';
import { createApp } from '../../apps/gateway/src/app.js';
import { PostgresRateLimiter } from '../../apps/gateway/src/rate-limit.js';
test('HTTP authentication, API key scopes/revocation, CORS, redaction and tenant boundaries', async () => {
  const f = await fixture(),
    connections = new ConnectionService(f.db, f.vault, f.registry);
  const server = createApp({
    connections,
    execution: f.execution,
    auth: f.auth,
    rateLimiter: new PostgresRateLimiter(f.db),
    webOrigin: 'http://localhost:3000',
    hosts: ['127.0.0.1'],
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer test-user',
    'x-organization-id': f.org,
  };
  try {
    expect((await fetch(base + '/api/tools')).status).toBe(401);
    expect(
      (
        await fetch(base + '/api/tools', {
          headers: { ...headers, 'x-organization-id': randomUUID() },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + '/api/tools', {
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    const preflight = await fetch(base + '/api/policy', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'PUT' },
    });
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
    const created = await fetch(base + '/api/keys', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Read only agent', scopes: ['demo.crm.customer.search'] }),
    });
    expect(created.status).toBe(201);
    const key = (await created.json()) as { id: string; key: string };
    expect(key.key).toMatch(/^omni_/);
    const agent = { ...headers, authorization: 'Bearer ' + key.key };
    expect(
      (await (await fetch(base + '/api/tools', { headers: agent })).json()) as unknown[],
    ).toHaveLength(1);
    const denied = await fetch(base + '/api/invoke', {
      method: 'POST',
      headers: agent,
      body: JSON.stringify({
        name: 'demo.crm.note.create',
        arguments: { customerId: f.customer, body: 'never log this' },
      }),
    });
    expect(((await denied.json()) as { status: string }).status).toBe('denied');
    const raw = JSON.stringify((await f.db.system.query('select * from executions')).rows);
    expect(raw).not.toContain('never log this');
    const consoleResponse = await (await fetch(base + '/api/console', { headers })).text();
    expect(consoleResponse).not.toContain(key.key);
    expect(consoleResponse).not.toContain('key_hash');
    expect(consoleResponse).not.toContain('ciphertext');
    expect(
      (
        await fetch(base + '/api/keys', {
          method: 'POST',
          headers: agent,
          body: JSON.stringify({ name: 'escalate', scopes: ['demo.crm.customer.search'] }),
        })
      ).status,
    ).toBe(403);
    await fetch(base + `/api/keys/${key.id}`, { method: 'DELETE', headers });
    expect((await fetch(base + '/api/tools', { headers: agent })).status).toBe(401);
    const tool = (await f.execution.list(f.principal))[0]!;
    await fetch(base + `/api/tools/${tool.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect((await f.execution.list(f.principal)).some((t) => t.id === tool.id)).toBe(false);
    const other = randomUUID();
    await f.db.system.query("insert into organizations(id,name) values($1,'Other')", [other]);
    const otherConnection = randomUUID();
    await f.db.system.query(
      "insert into connections(id,organization_id,name,connector_id) values($1,$2,'Other CRM','demo-crm')",
      [otherConnection, other],
    );
    expect(
      (
        await fetch(base + `/api/connections/${otherConnection}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ status: 'disabled' }),
        })
      ).status,
    ).toBe(404);
  } finally {
    server.close();
    await once(server, 'close');
    await f.db.close();
  }
});
test('database rate limiter shares durable counters and rejects excess requests', async () => {
  const f = await fixture();
  try {
    const a = new PostgresRateLimiter(f.db, 2),
      b = new PostgresRateLimiter(f.db, 2);
    await a.consume('tenant:agent');
    await b.consume('tenant:agent');
    await expect(a.consume('tenant:agent')).rejects.toThrow(/Rate limit/);
    await b.consume('other:agent');
  } finally {
    await f.db.close();
  }
});
