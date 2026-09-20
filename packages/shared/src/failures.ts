import { AppError, type Risk } from './index.js';

export type FailureKind =
  | 'validation_failure'
  | 'permission_failure'
  | 'approval_required'
  | 'transient_upstream_failure'
  | 'permanent_upstream_failure'
  | 'timeout'
  | 'connector_failure';
export function classifyFailure(error: unknown, risk: Risk = 'WRITE') {
  const code = error instanceof AppError ? error.code : 'CONNECTOR_FAILURE';
  let kind: FailureKind = 'connector_failure';
  if (/INVALID|VALIDATION|SCHEMA|RESPONSE_TOO_LARGE|SECRET_IN/.test(code))
    kind = 'validation_failure';
  else if (/FORBIDDEN|PERMISSION|SSRF|REDIRECT|WRITE_DISABLED|OAUTH_REAUTH_REQUIRED/.test(code))
    kind = 'permission_failure';
  else if (code === 'APPROVAL_REQUIRED') kind = 'approval_required';
  else if (/TIMEOUT|CANCELLED/.test(code)) kind = 'timeout';
  else if (/UPSTREAM_TRANSIENT|UPSTREAM_UNAVAILABLE|WORKER_BUSY/.test(code))
    kind = 'transient_upstream_failure';
  else if (/UPSTREAM_PERMANENT|DATABASE_ERROR/.test(code)) kind = 'permanent_upstream_failure';
  return {
    code,
    kind,
    retryable:
      risk === 'READ' &&
      ['timeout', 'transient_upstream_failure', 'connector_failure'].includes(kind),
    outcomeUnknown:
      risk !== 'READ' &&
      (['timeout', 'connector_failure', 'transient_upstream_failure'].includes(kind) ||
        /RESPONSE|DATABASE_ERROR|UPSTREAM_TOOL_ERROR/.test(code)),
  };
}
