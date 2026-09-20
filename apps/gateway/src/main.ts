import 'dotenv/config';
import { gatewayConfig } from '../../../packages/shared/src/config.js';
import { hydrateSecrets } from '../../../packages/shared/src/secret-provider.js';
import { HttpWorkerExecutor } from '../../../services/connector-worker/src/http.js';
import { initializeTelemetry, shutdownTelemetry } from '../../../packages/shared/src/telemetry.js';
import { PostgresDatabase } from '../../../packages/database/src/index.js';
import { AesGcmVault } from '../../../packages/shared/src/secrets.js';
import {
  ProcessExecutor,
  processRegistry,
} from '../../../services/connector-worker/src/process.js';
import { ConnectionService } from './connections.js';
import { ConnectorWorker } from '../../../services/connector-worker/src/index.js';
import { Authenticator, supabaseVerifier } from './auth.js';
import { ExecutionService } from './execution.js';
import { PostgresRateLimiter } from './rate-limit.js';
import { createApp } from './app.js';
import { OAuthService, loadOAuthProviders } from './oauth.js';
await hydrateSecrets();
const env = gatewayConfig();
initializeTelemetry('omnimcp-gateway');
const db = new PostgresDatabase(env.DATABASE_URL),
  vault = new AesGcmVault(env.MASTER_KEY),
  processExecutor = env.WORKER_URL
    ? new HttpWorkerExecutor(env.WORKER_URL, env.WORKER_AUTH_TOKEN!)
    : new ProcessExecutor({
        databaseUrl: env.DATABASE_URL,
        concurrency: env.WORKER_CONCURRENCY,
        timeoutMs: env.WORKER_TIMEOUT_MS,
      }),
  registry = await processRegistry(processExecutor);
const oauth = new OAuthService(db, vault, await loadOAuthProviders(), env.OAUTH_REDIRECT_BASE);
const auth = new Authenticator(db, supabaseVerifier(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)),
  execution = new ExecutionService(db, vault, new ConnectorWorker(registry), auth, oauth);
const app = createApp({
  execution,
  auth,
  connections: new ConnectionService(db, vault, registry, oauth),
  rateLimiter: new PostgresRateLimiter(db),
  webOrigin: env.WEB_ORIGIN,
  hosts: env.GATEWAY_HOSTS.split(','),
  workerHealth: () => processExecutor.health(),
  ready: async () => {
    await db.system.query('select trace_id,parent_span_id from executions limit 0');
    await db.system.query('select health_status from connections limit 0');
    if (processExecutor instanceof HttpWorkerExecutor) await processExecutor.ready();
    if (processExecutor.health().status !== 'ok') throw new Error('Worker unavailable');
  },
  oauth,
});
const server = app.listen(env.PORT, () =>
  process.stdout.write(`OmniMCP listening on ${env.PORT}\n`),
);
for (const event of ['SIGINT', 'SIGTERM'])
  process.on(event, () => {
    server.close(() => {
      void processExecutor
        .close()
        .then(() => db.close())
        .then(() => shutdownTelemetry())
        .then(() => process.exit(0));
    });
  });
