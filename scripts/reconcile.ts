import 'dotenv/config';
import { PostgresDatabase, audit } from '../packages/database/src/index.js';
const db = new PostgresDatabase(process.env.DATABASE_URL!);
try {
  const tenants = (await db.system.query<{ id: string }>('select id from organizations')).rows;
  let count = 0;
  for (const { id } of tenants)
    await db.tenant(id, async (sql) => {
      const rows = await sql.query<{ id: string }>(
        'update executions set status=\'unknown\',arguments_encrypted=null,finished_at=now(),error_metadata=\'{"code":"WORKER_INTERRUPTED","message":"Execution outcome is unknown; reconcile with upstream before retrying"}\' where organization_id=$1 and status=\'running\' and started_at<now()-interval \'5 minutes\' returning id',
        [id],
      );
      for (const execution of rows.rows) {
        await audit(sql, { organizationId: id, role: 'admin' }, 'execution.unknown', execution.id);
        count++;
      }
      await sql.query(
        "update executions set status='expired',arguments_encrypted=null,finished_at=now() where organization_id=$1 and status='pending' and id in(select execution_id from approval_requests where organization_id=$1 and status='pending' and expires_at<now())",
        [id],
      );
      await sql.query(
        "update approval_requests set status='expired',decided_at=now() where organization_id=$1 and status='pending' and expires_at<now()",
        [id],
      );
    });
  process.stdout.write(
    `Reconciled ${count} interrupted executions. No side effects were retried.\n`,
  );
} finally {
  await db.close();
}
