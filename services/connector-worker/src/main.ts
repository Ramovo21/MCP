import 'dotenv/config';
import { workerConfig } from '../../../packages/shared/src/config.js';
import { hydrateSecrets } from '../../../packages/shared/src/secret-provider.js';
import { PostgresDatabase } from '../../../packages/database/src/index.js';
import { ProcessExecutor, processRegistry } from './process.js';
import { workerApp } from './http.js';
import { initializeTelemetry, shutdownTelemetry } from '../../../packages/shared/src/telemetry.js';

await hydrateSecrets(undefined, ['DATABASE_URL', 'WORKER_AUTH_TOKEN']);
const config = workerConfig();
initializeTelemetry('omnimcp-worker');
const db = new PostgresDatabase(config.DATABASE_URL, 2);
const executor = new ProcessExecutor({
  databaseUrl: config.DATABASE_URL,
  concurrency: config.WORKER_CONCURRENCY,
  timeoutMs: config.WORKER_TIMEOUT_MS,
});
await processRegistry(executor);
const app = workerApp(executor, config.WORKER_AUTH_TOKEN, async () => {
  await db.system.query('select worker_claimed_at from executions limit 0');
});
const server = app.listen(config.WORKER_PORT, () =>
  process.stdout.write(`OmniMCP worker listening on ${config.WORKER_PORT}\n`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void executor.close().then(() => {
      server.close(() => {
        void db
          .close()
          .then(() => shutdownTelemetry())
          .then(() => process.exit(0));
      });
    });
  });
