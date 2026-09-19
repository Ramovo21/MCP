import { risks, type Principal, type ToolRecord } from '../../shared/src/index.js';
export interface Policy {
  allow_write: boolean;
  sensitive_approval: boolean;
  allow_self_approval: boolean;
}
export const defaultPolicy: Policy = {
  allow_write: false,
  sensitive_approval: true,
  allow_self_approval: false,
};
export function canUse(p: Principal, t: ToolRecord, permission?: boolean): boolean {
  const risk = risks[Math.max(risks.indexOf(t.risk), risks.indexOf(t.baseline_risk))];
  if (!t.enabled || p.organizationId !== t.organization_id || permission === false) return false;
  if (p.scopes && !p.scopes.includes(t.name)) return false;
  if (p.role === 'viewer' && risk !== 'READ') return false;
  if (risk === 'SENSITIVE' || risk === 'CRITICAL') return permission === true;
  return permission === true || ['owner', 'admin', 'developer'].includes(p.role) || risk === 'READ';
}
export function evaluate(t: ToolRecord, p: Policy): { approval: boolean; reason: string } {
  const risk = risks[Math.max(risks.indexOf(t.risk), risks.indexOf(t.baseline_risk))];
  if (risk === 'CRITICAL')
    return { approval: true, reason: 'Critical actions require explicit human approval' };
  if (risk === 'SENSITIVE' && p.sensitive_approval)
    return { approval: true, reason: 'Sensitive action requires organization approval' };
  if (risk === 'WRITE' && !p.allow_write)
    return { approval: true, reason: 'Organization policy requires approval for writes' };
  return { approval: false, reason: 'Allowed by organization policy' };
}
