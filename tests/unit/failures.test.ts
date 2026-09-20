import { test, expect } from 'vitest';
import { AppError } from '../../packages/shared/src/index.js';
import { classifyFailure } from '../../packages/shared/src/failures.js';
import { scrubSecrets } from '../../packages/shared/src/secrets.js';
test('failure classification permits READ retries but marks ambiguous writes unknown', () => {
  for (const [code, kind] of Object.entries({
    INVALID_INPUT: 'validation_failure',
    FORBIDDEN: 'permission_failure',
    APPROVAL_REQUIRED: 'approval_required',
    UPSTREAM_TRANSIENT: 'transient_upstream_failure',
    UPSTREAM_PERMANENT: 'permanent_upstream_failure',
    WORKER_TIMEOUT: 'timeout',
    CONNECTOR_FAILURE: 'connector_failure',
  }))
    expect(classifyFailure(new AppError(code, ''), 'READ').kind).toBe(kind);
  expect(classifyFailure(new AppError('WORKER_TIMEOUT', ''), 'WRITE')).toMatchObject({
    retryable: false,
    outcomeUnknown: true,
  });
  expect(classifyFailure(new AppError('UPSTREAM_TRANSIENT', ''), 'READ').retryable).toBe(true);
});
test('stored secrets are removed from unexpected response fields and arrays', () => {
  expect(
    scrubSecrets({ echo: ['Bearer stored-token'], 'stored-token': 'stored-token' }, [
      'stored-token',
    ]),
  ).toEqual({ echo: ['Bearer [REDACTED]'], '[REDACTED]': '[REDACTED]' });
});
