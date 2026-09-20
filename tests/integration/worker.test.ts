import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ProcessExecutor } from '../../services/connector-worker/src/process.js';
const job = () => ({
  version: 1 as const,
  operation: 'catalog' as const,
  executionId: randomUUID(),
  traceId: 'a'.repeat(32),
});
test('process cancellation terminates an uncooperative connector and releases capacity', async () => {
  const worker = new ProcessExecutor({
    databaseUrl: 'unused-test-fixture',
    module: new URL('../fixtures/worker-failure.ts', import.meta.url),
    timeoutMs: 5000,
  });
  const controller = new AbortController();
  const task = worker.run(job(), controller.signal);
  setTimeout(() => controller.abort(), 300);
  await expect(task).rejects.toMatchObject({ code: 'WORKER_CANCELLED' });
  expect(worker.health().active).toBe(0);
  await worker.close();
});
test('process crash is isolated and a duplicate cancellation never leaks worker slots', async () => {
  const worker = new ProcessExecutor({
    databaseUrl: 'unused-test-fixture',
    module: new URL('../fixtures/worker-failure.ts', import.meta.url),
    env: { AUDIT_WORKER_BEHAVIOR: 'crash' },
  });
  await expect(worker.run(job())).rejects.toMatchObject({ code: 'CONNECTOR_FAILURE' });
  expect(worker.health()).toMatchObject({ active: 0, crashes: 1, status: 'ok' });
  await worker.close();
  await expect(worker.run(job())).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
});
