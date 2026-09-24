import type { AuthProvider, TenantResolver } from '../../../packages/shared/src/auth.js';
import type { SecretProvider } from '../../../packages/shared/src/secret-provider.js';
import type { ExecutionStore, AuditStore } from '../../../packages/shared/src/storage.js';
import type { Database, Sql } from '../../../packages/database/src/index.js';
import {
  PostgresExecutionStore,
  PostgresAuditStore,
} from '../../../packages/database/src/execution-store.js';
import { AesGcmVault } from '../../../packages/shared/src/secrets.js';
import type { WorkerExecutor } from '../../../services/connector-worker/src/protocol.js';
import { processRegistry } from '../../../services/connector-worker/src/process.js';
import { ConnectorWorker } from '../../../services/connector-worker/src/index.js';
import { Authenticator, PostgresTenantResolver } from './auth.js';
import { ExecutionService } from './execution.js';
import { ConnectionService } from './connections.js';
import { ApprovalService } from './approvals.js';
import type { OAuthService } from './oauth.js';

export interface OmniMCPConfig {
  authProvider: AuthProvider;
  secretProvider: SecretProvider;
  database: Database;
  worker: WorkerExecutor;
  tenantResolver?: TenantResolver;
  executionStore?: ExecutionStore;
  /** Adapter for the default Postgres store. Custom stores own transactional audit(). */
  auditStore?: AuditStore<Sql>;
  oauth?: OAuthService;
}
/** No singleton, environment lookup, demo tenant or in-process execution fallback.
 * The isolated worker's deployed modules provide the connector catalog. */
export async function createOmniMCP(config: OmniMCPConfig) {
  for (const [key, method] of [
    ['authProvider', 'getUser'],
    ['secretProvider', 'getSecret'],
    ['database', 'tenant'],
    ['worker', 'run'],
  ] as const) {
    if (
      !config?.[key] ||
      typeof (config[key] as unknown as Record<string, unknown>)[method] !== 'function'
    )
      throw new Error(`OmniMCP requires ${key}.${method}`);
  }
  if (config.executionStore && config.auditStore)
    throw new Error(
      'Custom executionStore owns transactional audit; do not also supply a Postgres auditStore',
    );
  if (config.auditStore && typeof config.auditStore.append !== 'function')
    throw new Error('Invalid auditStore.append');
  if (config.executionStore && typeof config.executionStore.transaction !== 'function')
    throw new Error('Invalid executionStore.transaction');
  if (
    config.tenantResolver &&
    ['fromUser', 'fromApiKey', 'refresh'].some(
      (method) =>
        typeof (config.tenantResolver as unknown as Record<string, unknown>)[method] !== 'function',
    )
  )
    throw new Error('Invalid tenantResolver');
  const masterKey = await config.secretProvider.getSecret('MASTER_KEY');
  if (!masterKey) throw new Error('SecretProvider must supply MASTER_KEY');
  const vault = new AesGcmVault(masterKey);
  const registry = await processRegistry(config.worker);
  const auth = new Authenticator(
    config.tenantResolver ?? new PostgresTenantResolver(config.database),
    config.authProvider,
  );
  const store =
    config.executionStore ??
    new PostgresExecutionStore(config.database, config.auditStore ?? new PostgresAuditStore());
  const execution = new ExecutionService(
    config.database,
    vault,
    new ConnectorWorker(registry),
    auth,
    config.oauth,
    store,
  );
  return {
    auth,
    execution,
    registry,
    vault,
    approvals: new ApprovalService(execution),
    connections: new ConnectionService(config.database, vault, registry, config.oauth),
  };
}
