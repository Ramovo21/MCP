import { AppError, assertAdmin, type Principal } from '../../../packages/shared/src/index.js';
import type { ExecutionService } from './execution.js';
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
    const e = await this.execution.store.transaction(p.organizationId, async (tx) => {
      const approval = await tx.lockApproval(id);
      if (!approval) throw new AppError('NOT_FOUND', 'Approval not found', 404);
      if (approval.status !== 'pending')
        throw new AppError('ALREADY_DECIDED', 'Approval was already decided', 409);
      const execution = await tx.lockExecution(approval.execution_id);
      if (!execution) throw new AppError('NOT_FOUND', 'Execution not found', 404);
      const policy = await tx.policy();
      if (approval.requested_by === p.userId && !policy.allow_self_approval)
        throw new AppError(
          'SELF_APPROVAL_DENIED',
          'Another administrator must approve this action',
          403,
        );
      if (new Date(approval.expires_at).getTime() < Date.now()) {
        await tx.decideApproval(id, execution.id, 'expired');
        await tx.audit({ principal: p, action: 'approval.expired', target: id });
        return { ...execution, status: 'expired' };
      }
      if (execution.status !== 'pending')
        throw new AppError('ALREADY_CLAIMED', 'Execution is not pending', 409);
      await tx.decideApproval(id, execution.id, decision, p.userId);
      const status = decision === 'approved' ? 'running' : 'rejected';
      await tx.step(execution.id, `approval_${decision}`);
      await tx.audit({ principal: p, action: `approval.${decision}`, target: id });
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
