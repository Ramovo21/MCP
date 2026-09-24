import { PostgresDatabase } from '../../../packages/database/src/index.js';
import { AppError } from '../../../packages/shared/src/index.js';
import { loadRegistry } from '../../../apps/gateway/src/registry.js';
import { traceContext, traceEvent } from '../../../packages/shared/src/tracing.js';
import { scrubSecrets } from '../../../packages/shared/src/secrets.js';
import type { ConnectorContext } from '../../../packages/connector-sdk/src/index.js';
import {
  executeConnector,
  validateDefinitions,
} from '../../../packages/connector-sdk/src/contract.js';
import type { ExecutionJob, WorkerMessage } from './protocol.js';
import {
  initializeTelemetry,
  shutdownTelemetry,
  withSpan,
} from '../../../packages/shared/src/telemetry.js';

initializeTelemetry('omnimcp-connector');

function send(message: WorkerMessage) {
  process.send?.(message);
}
process.once('message', async (job: ExecutionJob) => {
  let db: PostgresDatabase | undefined;
  try {
    if (job.version !== 1) throw new AppError('INVALID_JOB', 'Unsupported job');
    const registry = await loadRegistry();
    const result = await traceContext.run(
      {
        traceId: job.traceId,
        spanId: job.parentSpanId,
        executionId: job.executionId,
        emit: (stage, metadata) => send({ type: 'trace', stage, metadata }),
      },
      async () => {
        if (job.operation === 'catalog')
          return registry.list().map((m) => ({ ...m, schema: 'schema' in registry.get(m.id) }));
        if (
          !job.connection ||
          !job.organizationId ||
          job.connection.organization_id !== job.organizationId
        )
          throw new AppError('INVALID_JOB', 'Tenant mismatch');
        db = new PostgresDatabase(process.env.DATABASE_URL!, 1);
        const connector = registry.get(job.connection.connector_id);
        const ctx: ConnectorContext = {
          connection: job.connection,
          organizationId: job.organizationId,
          secrets: job.secrets ?? {},
          database: db,
          executionId: job.executionId,
          signal: AbortSignal.timeout(30000),
        };
        traceEvent('worker_started', { pid: process.pid, operation: job.operation });
        if (job.operation === 'execute') {
          if (
            !job.tool ||
            job.tool.organization_id !== job.organizationId ||
            job.tool.connection_id !== job.connection.id
          )
            throw new AppError('INVALID_JOB', 'Tool binding mismatch');
          const claim = await db.tenant(job.organizationId, (sql) =>
            sql.query(
              "update executions set worker_claimed_at=now() where organization_id=$1 and id=$2 and status='running' and worker_claimed_at is null returning id",
              [job.organizationId, job.executionId],
            ),
          );
          if (!claim.rows.length)
            throw new AppError('ALREADY_CLAIMED', 'Execution job already claimed', 409);
          traceEvent('connector_started', { connector: connector.id });
          return withSpan(
            'connector.execute',
            {
              connector: connector.id,
              tool: job.tool.name,
              organizationId: job.organizationId,
              executionId: job.executionId,
            },
            () => executeConnector(connector, job.tool!, job.arguments ?? {}, ctx),
          );
        }
        if (job.operation === 'discover') {
          const definitions = await connector.discover(ctx);
          validateDefinitions(definitions);
          return definitions;
        }
        if (job.operation === 'initialize') {
          await connector.initialize?.(ctx);
          return { ok: true };
        }
        if (job.operation === 'test') {
          if (connector.test) await connector.test(ctx);
          else await connector.discover(ctx);
          return { ok: true };
        }
        const schemaConnector = connector as typeof connector & {
          schema?: (ctx: ConnectorContext) => Promise<unknown>;
        };
        if (!schemaConnector.schema)
          throw new AppError('UNSUPPORTED', 'Schema discovery unsupported');
        return schemaConnector.schema(ctx);
      },
    );
    const safe = scrubSecrets(result, Object.values(job.secrets ?? {}));
    if (Buffer.byteLength(JSON.stringify(safe) ?? 'null') > 2 * 1024 * 1024)
      throw new AppError('RESPONSE_TOO_LARGE', 'Result too large');
    send({ type: 'result', result: safe });
  } catch (error) {
    send({
      type: 'error',
      code:
        error instanceof AppError && /^[A-Z_]{1,80}$/.test(error.code)
          ? error.code
          : 'CONNECTOR_FAILURE',
    });
  } finally {
    await db?.close();
    await shutdownTelemetry();
    process.disconnect?.();
  }
});
process.on('disconnect', () => process.exit(0));
send({ type: 'ready' });
