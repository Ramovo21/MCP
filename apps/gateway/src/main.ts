import 'dotenv/config';
import { gatewayConfig } from '../../../packages/shared/src/config.js';
import {
  hydrateSecrets,
  EnvironmentSecretProvider,
} from '../../../packages/shared/src/secret-provider.js';
import { HttpWorkerExecutor } from '../../../services/connector-worker/src/http.js';
import { initializeTelemetry, shutdownTelemetry } from '../../../packages/shared/src/telemetry.js';
import { PostgresDatabase } from '../../../packages/database/src/index.js';
import { AesGcmVault } from '../../../packages/shared/src/secrets.js';
import { ProcessExecutor } from '../../../services/connector-worker/src/process.js';
import { SupabaseAuthProvider } from './auth.js';
import { createOmniMCP } from './framework.js';
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
      });
const oauth = new OAuthService(db, vault, await loadOAuthProviders(), env.OAUTH_REDIRECT_BASE);
const { auth, execution, connections } = await createOmniMCP({
  database: db,
  worker: processExecutor,
  oauth,
  secretProvider: new EnvironmentSecretProvider(),
  authProvider: new SupabaseAuthProvider(env.SUPABASE_URL, env.SUPABASE_ANON_KEY),
});
const app = createApp({
  execution,
  auth,
  connections,
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
