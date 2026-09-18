import { expect, test } from 'vitest';
import { fixture } from '../helpers/fixture.js';
import { ApprovalService } from '../../apps/gateway/src/approvals.js';
test('CRITICAL approval executes one time under racing decisions and idempotent calls', async () => {
  const f = await fixture();
  try {
    await f.db.system.query("update tools set risk='CRITICAL' where name='demo.crm.note.create'");
    await f.db.system.query(
      "insert into tool_permissions select organization_id,id,'owner',true from tools where name='demo.crm.note.create'",
    );
    const pending = await f.execution.call(
      f.principal,
      'demo.crm.note.create',
      { customerId: f.customer, body: 'approved note' },
      'approval-test',
    );
    expect(pending.status).toBe('pending');
    const id = String((await f.db.system.query('select id from approval_requests')).rows[0]!.id);
    const service = new ApprovalService(f.execution);
    await expect(service.decide(f.principal, id, 'approved')).rejects.toThrow(/Another/);
    const p = { ...f.principal, userId: f.approver, role: 'admin' as const };
    const decisions = await Promise.allSettled([
      service.decide(p, id, 'approved'),
      service.decide(p, id, 'approved'),
    ]);
    expect(decisions.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await f.db.system.query('select body from demo_notes')).rows).toEqual([
      { body: 'approved note' },
    ]);
    expect(
      (
        await f.execution.call(
          f.principal,
          'demo.crm.note.create',
          { customerId: f.customer, body: 'approved note' },
          'approval-test',
        )
      ).status,
    ).toBe('succeeded');
    expect((await f.db.system.query('select * from demo_notes')).rows).toHaveLength(1);
    await expect(
      f.execution.call(
        f.principal,
        'demo.crm.note.create',
        { customerId: f.customer, body: 'changed' },
        'approval-test',
      ),
    ).rejects.toThrow(/another request/);
  } finally {
    await f.db.close();
  }
});
test('rejected, expired and revoked-principal approvals never dispatch', async () => {
  const f = await fixture();
  try {
    const service = new ApprovalService(f.execution),
      admin = { ...f.principal, userId: f.approver, role: 'admin' as const };
    for (const mode of ['rejected', 'expired', 'revoked']) {
      const p =
        mode === 'revoked' ? await f.auth.authenticate('Bearer ' + f.key, undefined) : f.principal;
      const pending = await f.execution.call(p, 'demo.crm.note.create', {
        customerId: f.customer,
        body: mode,
      });
      const a = (
        await f.db.system.query('select id from approval_requests where execution_id=$1', [
          pending.executionId,
        ])
      ).rows[0]!;
      if (mode === 'expired')
        await f.db.system.query(
          "update approval_requests set expires_at=now()-interval '1 hour' where id=$1",
          [a.id],
        );
      if (mode === 'revoked') await f.db.system.query('update api_keys set revoked_at=now()');
      const result = await service.decide(
        admin,
        String(a.id),
        mode === 'rejected' ? 'rejected' : 'approved',
      );
      expect(result.status).toBe(mode === 'revoked' ? 'failed' : mode);
    }
    expect((await f.db.system.query('select * from demo_notes')).rows).toHaveLength(0);
  } finally {
    await f.db.close();
  }
});
