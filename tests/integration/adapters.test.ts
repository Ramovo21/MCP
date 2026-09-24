import { test, expect } from 'vitest';
import { fixture } from '../helpers/fixture.js';
import { PostgresExecutionStore } from '../../packages/database/src/execution-store.js';
import { ExecutionService } from '../../apps/gateway/src/execution.js';
import { ConnectorWorker } from '../../services/connector-worker/src/index.js';
import { createOmniMCP, type OmniMCPConfig } from '../../apps/gateway/src/framework.js';
test('injected transactional audit failure rolls back execution and prevents dispatch', async () => {
  const f = await fixture();
  try {
    const store = new PostgresExecutionStore(f.db, {
      async append() {
        throw Error('Audit unavailable');
      },
    });
    const service = new ExecutionService(
      f.db,
      f.vault,
      new ConnectorWorker(f.registry),
      f.auth,
      undefined,
      store,
    );
    await expect(service.call(f.principal, 'demo.crm.customer.search', {})).rejects.toThrow(
      'Audit unavailable',
    );
    expect((await f.db.system.query('select * from executions')).rows).toHaveLength(0);
    expect((await f.db.system.query('select * from execution_steps')).rows).toHaveLength(0);
  } finally {
    await f.db.close();
  }
});
test('framework fails fast on missing identity or encryption config before starting worker', async () => {
  await expect(createOmniMCP({} as OmniMCPConfig)).rejects.toThrow('authProvider');
  const f = await fixture();
  try {
    await expect(
      createOmniMCP({
        database: f.db,
        authProvider: {
          async getUser() {
            return { id: f.user };
          },
        },
        secretProvider: {
          async getSecret() {
            return null;
          },
          async setSecret() {},
          async deleteSecret() {},
        },
        worker: {
          async run() {
            throw Error('Worker must not start');
          },
          health() {
            return { status: 'ok', active: 0, waiting: 0, crashes: 0, capacity: 1 };
          },
          async close() {},
        },
      }),
    ).rejects.toThrow('MASTER_KEY');
  } finally {
    await f.db.close();
  }
});
