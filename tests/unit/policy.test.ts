import { expect, test } from 'vitest';
import { canUse, evaluate, defaultPolicy } from '../../packages/policy-engine/src/index.js';
import type { ToolRecord } from '../../packages/shared/src/index.js';
const tool: ToolRecord = {
  id: 't',
  organization_id: 'a',
  connection_id: 'c',
  name: 'crm.note.create',
  description: 'Create a note',
  input_schema: { type: 'object' },
  risk: 'READ',
  baseline_risk: 'READ',
  enabled: true,
  config: {},
};
test('risk policy cannot auto-run CRITICAL and sensitive tools require explicit grants', () => {
  const p = { organizationId: 'a', role: 'owner' as const };
  expect(canUse(p, { ...tool, risk: 'CRITICAL' })).toBe(false);
  expect(canUse(p, { ...tool, baseline_risk: 'CRITICAL' })).toBe(false);
  expect(canUse(p, { ...tool, risk: 'CRITICAL' }, true)).toBe(true);
  expect(canUse({ ...p, organizationId: 'b' }, tool, true)).toBe(false);
  expect(canUse({ ...p, scopes: [] }, tool, true)).toBe(false);
  expect(canUse(p, tool, false)).toBe(false);
  expect(
    evaluate(
      { ...tool, risk: 'CRITICAL' },
      { allow_write: true, sensitive_approval: false, allow_self_approval: true },
    ).approval,
  ).toBe(true);
  expect(evaluate({ ...tool, risk: 'WRITE' }, defaultPolicy).approval).toBe(true);
  expect(evaluate(tool, defaultPolicy).approval).toBe(false);
});
