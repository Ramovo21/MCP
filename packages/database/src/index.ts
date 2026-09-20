import pg from 'pg';
import type { Principal } from '../../shared/src/index.js';
export interface Sql {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}
export interface Database {
  system: Sql;
  tenant<T>(organizationId: string, fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export class PostgresDatabase implements Database {
  readonly pool: pg.Pool;
  readonly system: Sql;
  constructor(url: string, max = 20) {
    this.pool = new pg.Pool({
      connectionString: url,
      max,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
    this.system = this.pool;
    // Idle clients can fail during a database restart. Consume the pool error without
    // printing driver messages (which may contain connection strings); later queries retry
    // by acquiring a fresh connection. Individual in-flight queries still fail normally.
    this.pool.on('error', () => {
      process.stderr.write('{"level":"warn","code":"DATABASE_IDLE_CONNECTION_LOST"}\n');
    });
  }
  async tenant<T>(organizationId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role omnimcp_gateway');
      await c.query("select set_config('app.organization_id',$1,true)", [organizationId]);
      const result = await fn(c);
      await c.query('commit');
      return result;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}
export async function audit(
  sql: Sql,
  p: Principal,
  action: string,
  target?: string,
  metadata: unknown = {},
) {
  await sql.query(
    'insert into audit_logs(organization_id,actor_id,action,target_id,metadata) values($1,$2,$3,$4,$5)',
    [
      p.organizationId,
      p.userId ?? p.apiKeyId ?? 'system',
      action,
      target ?? null,
      JSON.stringify(metadata),
    ],
  );
}
