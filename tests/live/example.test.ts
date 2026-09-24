import 'dotenv/config';
import { test, expect } from 'vitest';
import { startExample } from '../../examples/simple-project/runtime.js';
import { verifyExample } from '../../examples/simple-project/verify.js';
test('reusable project: custom identity, real MCP, PostgreSQL approval, child worker, backend and audit', async () => {
  if (!process.env.DATABASE_URL) throw Error('Local DATABASE_URL required');
  const e = await startExample(process.env.DATABASE_URL);
  try {
    const report = await verifyExample({
      url: e.url,
      organizationId: e.org,
      userToken: e.userToken,
      approverToken: e.approverToken,
    });
    expect(report).toMatchObject({
      listed: 4,
      readCalls: 2,
      criticalApproved: 1,
      duplicateApprovalRejected: true,
    });
    expect(e.backend.counts()).toEqual({ created: 1, cancelled: 1 });
    expect(e.worker.health().active).toBe(0);
    const audits = (
      await e.db.system.query<{ action: string }>(
        'select action from audit_logs where organization_id=$1',
        [e.org],
      )
    ).rows.map((r) => r.action);
    expect(audits).toContain('approval.approved');
    expect(audits).toContain('tool.succeeded');
  } finally {
    await e.close();
  }
}, 60000);
