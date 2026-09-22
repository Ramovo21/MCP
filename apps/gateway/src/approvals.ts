import { audit } from '../../../packages/database/src/index.js';
import { AppError, assertAdmin, type Principal } from '../../../packages/shared/src/index.js';
import type { ExecutionService, Execution } from './execution.js';
import { withSpan } from '../../../packages/shared/src/telemetry.js';
import { traceContext } from '../../../packages/shared/src/tracing.js';
export class ApprovalService {
  constructor(private execution: ExecutionService) {}
  async decide(p: Principal, id: string, decision: 'approved' | 'rejected') {
    return withSpan('gateway.approval', { organizationId: p.organizationId, decision }, () =>
      this.decideOnce(p, id, decision),
    );
  }
  private async decideOnce(p: Principal, id: string, decision: 'approved' | 'rejected') {
    assertAdmin(p);
    const e = await this.execution.db.tenant(p.organizationId, async (sql) => {
      const approval = (
        await sql.query<{
          execution_id: string;
          status: string;
          requested_by: string | null;
          expires_at: string;
        }>('select * from approval_requests where organization_id=$1 and id=$2 for update', [
          p.organizationId,
          id,
        ])
      ).rows[0];
      if (!approval) throw new AppError('NOT_FOUND', 'Approval not found', 404);
      if (approval.status !== 'pending')
        throw new AppError('ALREADY_DECIDED', 'Approval was already decided', 409);
      const execution = (
        await sql.query<Execution>(
          'select * from executions where organization_id=$1 and id=$2 for update',
          [p.organizationId, approval.execution_id],
        )
      ).rows[0]!;
      const policy = await this.execution.policy(sql, p.organizationId);
      if (approval.requested_by === p.userId && !policy.allow_self_approval)
        throw new AppError(
          'SELF_APPROVAL_DENIED',
          'Another administrator must approve this action',
          403,
        );
      if (new Date(approval.expires_at).getTime() < Date.now()) {
        await sql.query(
          "update approval_requests set status='expired',decided_at=now() where organization_id=$1 and id=$2",
          [p.organizationId, id],
        );
        await sql.query(
          "update executions set status='expired',arguments_encrypted=null,finished_at=now() where organization_id=$1 and id=$2",
          [p.organizationId, execution.id],
        );
        await audit(sql, p, 'approval.expired', id);
        return { ...execution, status: 'expired' };
      }
      if (execution.status !== 'pending')
        throw new AppError('ALREADY_CLAIMED', 'Execution is not pending', 409);
      await sql.query(
        'update approval_requests set status=$3,decided_by=$4,decided_at=now() where organization_id=$1 and id=$2',
        [p.organizationId, id, decision, p.userId],
      );
      const status = decision === 'approved' ? 'running' : 'rejected';
      await sql.query(
        "update executions set status=$3,arguments_encrypted=case when $3='rejected' then null else arguments_encrypted end,finished_at=case when $3='rejected' then now() else null end where organization_id=$1 and id=$2",
        [p.organizationId, execution.id, status],
      );
      await this.execution.step(sql, p.organizationId, execution.id, `approval_${decision}`);
      await audit(sql, p, `approval.${decision}`, id);
      return { ...execution, status };
    });
    const span = traceContext.getStore()?.span;
    span?.setAttribute('executionId', e.id);
    if (e.parent_span_id)
      span?.addLink({ context: { traceId: e.trace_id, spanId: e.parent_span_id, traceFlags: 1 } });
    if (e.status === 'running') return this.execution.dispatch(e, e.principal);
    return this.execution.response(e);
  }
}
