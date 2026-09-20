import 'dotenv/config';
import { z } from 'zod';
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
const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    SUPABASE_URL: z.url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    MASTER_KEY: z.string(),
    WEB_ORIGIN: z.url().default('http://localhost:3000'),
    PORT: z.coerce.number().default(4000),
    GATEWAY_HOSTS: z.string().default('localhost,127.0.0.1'),
  })
  .parse(process.env);
const db = new PostgresDatabase(env.DATABASE_URL),
  vault = new AesGcmVault(env.MASTER_KEY),
  processExecutor = new ProcessExecutor({
    databaseUrl: env.DATABASE_URL,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
    timeoutMs: Number(process.env.WORKER_TIMEOUT_MS ?? 30000),
  }),
  registry = await processRegistry(processExecutor);
const oauth = new OAuthService(
  db,
  vault,
  await loadOAuthProviders(),
  process.env.OAUTH_REDIRECT_BASE ?? `http://localhost:${env.PORT}`,
);
const auth = new Authenticator(db, supabaseVerifier(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)),
  execution = new ExecutionService(db, vault, new ConnectorWorker(registry), auth, oauth);
const app = createApp({
  execution,
  auth,
  connections: new ConnectionService(db, vault, registry),
  rateLimiter: new PostgresRateLimiter(db),
  webOrigin: env.WEB_ORIGIN,
  hosts: env.GATEWAY_HOSTS.split(','),
  workerHealth: () => processExecutor.health(),
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
        .then(() => process.exit(0));
    });
  });
