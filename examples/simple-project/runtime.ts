import { once } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { PostgresDatabase } from '../../packages/database/src/index.js';
import { createOmniMCP } from '../../apps/gateway/src/framework.js';
import { EnvironmentSecretProvider } from '../../packages/shared/src/secret-provider.js';
import { ProcessExecutor } from '../../services/connector-worker/src/process.js';
import { createApp } from '../../apps/gateway/src/app.js';
import { PostgresRateLimiter } from '../../apps/gateway/src/rate-limit.js';
import { AppError } from '../../packages/shared/src/index.js';
import { exampleBackend, type ExampleBackend } from './backend.js';

export interface ExampleRuntime {
  url: string;
  org: string;
  userToken: string;
  approverToken: string;
  db: PostgresDatabase;
  backend: ExampleBackend;
  worker: ProcessExecutor;
  close(): Promise<void>;
}
export async function startExample(databaseUrl: string, port = 0): Promise<ExampleRuntime> {
  if (
    process.env.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)
  )
    throw Error('Example requires a local development database');
  const db = new PostgresDatabase(databaseUrl);
  const org = randomUUID(),
    user = randomUUID(),
    approver = randomUUID();
  const userToken = randomBytes(32).toString('hex'),
    approverToken = randomBytes(32).toString('hex'),
    backendToken = randomBytes(32).toString('hex');
  const backend = exampleBackend(backendToken);
  let backendServer: Server | undefined, gateway: Server | undefined;
  const moduleUrl = new URL(
    import.meta.url.endsWith('.ts') ? './connector.ts' : './connector.js',
    import.meta.url,
  );
  const worker = new ProcessExecutor({ databaseUrl, env: { CONNECTOR_MODULES: moduleUrl.href } });
  const closeServer = async (server?: Server) => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  };
  const close = async () => {
    await closeServer(gateway);
    await worker.close();
    await closeServer(backendServer);
    for (const table of [
      'oauth_states',
      'oauth_tokens',
      'execution_steps',
      'approval_requests',
      'executions',
      'tool_permissions',
      'tools',
      'webhook_events',
      'mcp_servers',
      'connection_secrets',
      'connections',
      'api_keys',
      'audit_logs',
      'demo_notes',
      'demo_customers',
      'approval_policies',
      'organization_members',
    ])
      await db.system.query(`delete from ${table} where organization_id=$1`, [org]);
    await db.system.query('delete from organizations where id=$1', [org]);
    await db.system.query('delete from auth.users where id=any($1::uuid[])', [[user, approver]]);
    await db.close();
  };
  try {
    await db.system.query('insert into auth.users(id,email) values($1,$3),($2,$4)', [
      user,
      approver,
      `${user}@example.test`,
      `${approver}@example.test`,
    ]);
    await db.system.query(
      "insert into organizations(id,name) values($1,'Simple project example')",
      [org],
    );
    await db.system.query(
      "insert into organization_members values($1,$2,'owner'),($1,$3,'admin')",
      [org, user, approver],
    );
    await db.system.query(
      'insert into approval_policies(organization_id,allow_write) values($1,true)',
      [org],
    );
    backendServer = backend.app.listen(0, '127.0.0.1');
    await once(backendServer, 'listening');
    const address = backendServer.address();
    if (!address || typeof address === 'string') throw Error('No backend address');
    const services = await createOmniMCP({
      database: db,
      worker,
      secretProvider: new EnvironmentSecretProvider({
        MASTER_KEY: randomBytes(32).toString('base64'),
      }),
      authProvider: {
        async getUser(token) {
          for (const [credential, id] of [
            [userToken, user],
            [approverToken, approver],
          ]) {
            if (
              token.length === credential!.length &&
              timingSafeEqual(Buffer.from(token), Buffer.from(credential!))
            )
              return { id: id! };
          }
          throw new AppError('UNAUTHENTICATED', 'Invalid example token', 401);
        },
      },
    });
    const principal = { organizationId: org, userId: user, role: 'owner' as const };
    const connection = await services.connections.create(principal, {
      name: 'Simple project',
      connectorId: 'simple-project',
      config: { baseUrl: `http://127.0.0.1:${address.port}` },
      secrets: { backendToken },
    });
    await services.connections.import(principal, connection.id, [
      'customer.get',
      'product.search',
      'order.create',
      'order.cancel',
    ]);
    await db.system.query(
      "insert into tool_permissions select organization_id,id,'owner',true from tools where organization_id=$1 and name='order.cancel'",
      [org],
    );
    gateway = createApp({
      ...services,
      rateLimiter: new PostgresRateLimiter(db),
      webOrigin: 'http://localhost:3000',
      hosts: ['127.0.0.1', 'localhost'],
      workerHealth: () => worker.health(),
      ready: async () => {
        await db.system.query('select 1');
      },
    }).listen(port, '127.0.0.1');
    await once(gateway, 'listening');
    const a = gateway.address();
    if (!a || typeof a === 'string') throw Error('No gateway address');
    return {
      url: `http://127.0.0.1:${a.port}`,
      org,
      userToken,
      approverToken,
      db,
      backend,
      worker,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
