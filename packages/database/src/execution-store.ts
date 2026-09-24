import { randomUUID } from 'node:crypto';
import { audit, type Database, type Sql } from './index.js';
import { defaultPolicy, type Policy } from '../../policy-engine/src/index.js';
import type { Connection } from '../../shared/src/index.js';
import type {
  AuditEvent,
  AuditStore,
  AvailableTool,
  ApprovalRecord,
  ExecutionRecord,
  ExecutionStore,
  ExecutionTransaction,
} from '../../shared/src/storage.js';

export class PostgresAuditStore implements AuditStore<Sql> {
  append(sql: Sql, e: AuditEvent) {
    return audit(sql, e.principal, e.action, e.target, e.metadata);
  }
}
export class PostgresExecutionStore implements ExecutionStore {
  constructor(
    private db: Database,
    private auditStore: AuditStore<Sql> = new PostgresAuditStore(),
  ) {}
  transaction<T>(org: string, fn: (tx: ExecutionTransaction) => Promise<T>): Promise<T> {
    return this.db.tenant(org, (sql) => fn(postgresTransaction(sql, org, this.auditStore)));
  }
}
export function postgresTransaction(
  sql: Sql,
  org: string,
  auditStore: AuditStore<Sql> = new PostgresAuditStore(),
): ExecutionTransaction {
  return {
    async tools(p, name) {
      if (p.organizationId !== org) throw new Error('Transaction tenant mismatch');
      return (
        await sql.query<AvailableTool>(
          `select t.*,c.status connection_status,p.allowed permission from tools t join connections c on c.organization_id=t.organization_id and c.id=t.connection_id left join tool_permissions p on p.organization_id=t.organization_id and p.tool_id=t.id and p.role=$2 where t.organization_id=$1 ${name === undefined ? '' : 'and t.name=$3'} order by t.name`,
          name === undefined ? [org, p.role] : [org, p.role, name],
        )
      ).rows;
    },
    async policy() {
      return (
        (await sql.query<Policy>('select * from approval_policies where organization_id=$1', [org]))
          .rows[0] ?? defaultPolicy
      );
    },
    async findByKey(key) {
      return (
        await sql.query<ExecutionRecord>(
          'select * from executions where organization_id=$1 and idempotency_key=$2',
          [org, key],
        )
      ).rows[0];
    },
    async create(i) {
      if (i.principal.organizationId !== org) throw new Error('Transaction tenant mismatch');
      const r = (
        await sql.query<ExecutionRecord>(
          `insert into executions(id,organization_id,request_id,user_id,api_key_id,tool_id,tool_name,principal,arguments_redacted,arguments_encrypted,request_hash,idempotency_key,status,error_metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict(organization_id,idempotency_key) do nothing returning *`,
          [
            i.id,
            org,
            randomUUID(),
            i.principal.userId ?? null,
            i.principal.apiKeyId ?? null,
            i.toolId ?? null,
            i.name,
            JSON.stringify(i.principal),
            JSON.stringify(i.redacted),
            i.encrypted,
            i.fingerprint,
            i.key,
            i.status,
            i.error ? JSON.stringify(i.error) : null,
          ],
        )
      ).rows[0];
      if (r && i.status === 'denied')
        await sql.query(
          'update executions set finished_at=now(),duration_ms=0 where organization_id=$1 and id=$2',
          [org, i.id],
        );
      return r;
    },
    async trace(id, traceId, parent) {
      await sql.query(
        'update executions set trace_id=$3,parent_span_id=$4 where organization_id=$1 and id=$2',
        [org, id, traceId, parent ?? null],
      );
    },
    async step(id, stage, metadata = {}) {
      await sql.query(
        'insert into execution_steps(organization_id,execution_id,stage,metadata) values($1,$2,$3,$4)',
        [org, id, stage, JSON.stringify(metadata)],
      );
    },
    async audit(e) {
      if (e.principal.organizationId !== org) throw new Error('Audit tenant mismatch');
      await auditStore.append(sql, e);
    },
    async createApproval(id, risk, reason, user) {
      await sql.query(
        'insert into approval_requests(organization_id,execution_id,risk,reason,requested_by) values($1,$2,$3,$4,$5)',
        [org, id, risk, reason, user ?? null],
      );
    },
    async approved(id) {
      return !!(
        await sql.query(
          "select id from approval_requests where organization_id=$1 and execution_id=$2 and status='approved'",
          [org, id],
        )
      ).rows[0];
    },
    async connection(id) {
      const connection = (
        await sql.query<Connection>(
          'select * from connections where organization_id=$1 and id=$2',
          [org, id],
        )
      ).rows[0];
      if (!connection) throw new Error('Connection unavailable');
      const secret = (
        await sql.query<{ ciphertext: string }>(
          'select ciphertext from connection_secrets where organization_id=$1 and connection_id=$2',
          [org, id],
        )
      ).rows[0];
      return { connection, ciphertext: secret?.ciphertext };
    },
    async connector(id, connector) {
      await sql.query('update executions set connector_id=$3 where organization_id=$1 and id=$2', [
        org,
        id,
        connector,
      ]);
    },
    async finish(id, status, result, error, duration) {
      await sql.query(
        "update executions set status=$3,result_metadata=$4,error_metadata=$5,finished_at=now(),duration_ms=$6,arguments_encrypted=null where organization_id=$1 and id=$2 and status='running'",
        [org, id, status, JSON.stringify(result), JSON.stringify(error), duration],
      );
    },
    async lockApproval(id) {
      return (
        await sql.query<ApprovalRecord>(
          'select * from approval_requests where organization_id=$1 and id=$2 for update',
          [org, id],
        )
      ).rows[0];
    },
    async lockExecution(id) {
      return (
        await sql.query<ExecutionRecord>(
          'select * from executions where organization_id=$1 and id=$2 for update',
          [org, id],
        )
      ).rows[0];
    },
    async decideApproval(id, executionId, decision, userId) {
      await sql.query(
        'update approval_requests set status=$3,decided_by=$4,decided_at=now() where organization_id=$1 and id=$2',
        [org, id, decision, userId ?? null],
      );
      const status = decision === 'approved' ? 'running' : decision;
      await sql.query(
        "update executions set status=$3,arguments_encrypted=case when $3='running' then arguments_encrypted else null end,finished_at=case when $3='running' then null else now() end where organization_id=$1 and id=$2",
        [org, executionId, status],
      );
    },
  };
}
