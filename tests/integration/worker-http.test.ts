import { test, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { workerApp, HttpWorkerExecutor } from '../../services/connector-worker/src/http.js';
import { ProcessExecutor } from '../../services/connector-worker/src/process.js';
const job = () => ({
  version: 1 as const,
  operation: 'catalog' as const,
  executionId: randomUUID(),
  traceId: 'b'.repeat(32),
});
test('private HTTP worker authenticates jobs, validates envelopes and recovers readiness after dependency failure', async () => {
  let databaseAvailable = true;
  const executor = new ProcessExecutor({ databaseUrl: 'not-used-for-catalog' });
  const token = randomBytes(32).toString('hex');
  const server = workerApp(executor, token, async () => {
    if (!databaseAvailable) throw new Error('test DB down');
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new HttpWorkerExecutor(url, token);
  try {
    expect((await fetch(url + '/health')).status).toBe(200);
    expect((await fetch(url + '/jobs', { method: 'POST', body: '{}' })).status).toBe(401);
    expect(
      (
        await fetch(url + '/jobs', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: '{malformed',
        })
      ).status,
    ).toBe(400);
    await client.ready();
    expect(client.health().status).toBe('ok');
    const catalog = (await client.run(job())) as { id: string }[];
    expect(catalog.some((c) => c.id === 'google-workspace')).toBe(true);
    databaseAvailable = false;
    await expect(client.ready()).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
    databaseAvailable = true;
    await client.ready();
    expect(client.health().status).toBe('ok');
  } finally {
    await executor.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test('HTTP cancellation kills a hung child; child crash does not kill the worker HTTP server', async () => {
  for (const behavior of ['hang', 'crash']) {
    const executor = new ProcessExecutor({
      databaseUrl: 'unused',
      module: new URL('../fixtures/worker-failure.ts', import.meta.url),
      env: { AUDIT_WORKER_BEHAVIOR: behavior },
    });
    const token = randomBytes(32).toString('hex'),
      server = workerApp(executor, token, async () => {}).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      client = new HttpWorkerExecutor(url, token);
    try {
      await expect(client.run(job(), AbortSignal.timeout(1500))).rejects.toBeDefined();
      await new Promise((r) => setTimeout(r, 300));
      expect(executor.health().active).toBe(0);
      expect((await fetch(url + '/health')).status).toBe(200);
    } finally {
      await executor.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});
