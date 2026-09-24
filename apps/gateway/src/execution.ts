import { randomUUID } from 'node:crypto';
import { type Database, type Sql } from '../../../packages/database/src/index.js';
import {
  AppError,
  risks,
  publicError,
  type Principal,
  type ToolRecord,
  type JsonObject,
} from '../../../packages/shared/src/index.js';
import { canonical, hash, redact, type SecretVault } from '../../../packages/shared/src/secrets.js';
import { canUse, evaluate } from '../../../packages/policy-engine/src/index.js';
import { validateInput } from '../../../packages/mcp-core/src/validation.js';
import type { ConnectorWorker } from '../../../services/connector-worker/src/index.js';
import type { Authenticator } from './auth.js';
import type {
  ExecutionRecord,
  ExecutionStore,
  ExecutionTransaction,
} from '../../../packages/shared/src/storage.js';
import {
  PostgresExecutionStore,
  postgresTransaction,
} from '../../../packages/database/src/execution-store.js';
import { classifyFailure } from '../../../packages/shared/src/failures.js';
import { newTraceId, traceContext } from '../../../packages/shared/src/tracing.js';
import { scrubSecrets } from '../../../packages/shared/src/secrets.js';
import type { OAuthService } from './oauth.js';
import { logger } from '../../../packages/shared/src/logging.js';
import { withSpan } from '../../../packages/shared/src/telemetry.js';
export type Execution = ExecutionRecord;
export class ExecutionService {
  readonly store: ExecutionStore;
  constructor(
    readonly db: Database,
    readonly vault: SecretVault,
    private worker: ConnectorWorker,
    readonly auth: Pick<Authenticator, 'refresh'>,
    private oauth?: OAuthService,
    store?: ExecutionStore,
  ) {
    this.store = store ?? new PostgresExecutionStore(db);
  }
  async resolve(tx: ExecutionTransaction, p: Principal, name: string) {
    const tool = (await tx.tools(p, name))[0];
    if (
      !tool ||
      tool.connection_status !== 'active' ||
      !canUse(p, tool, tool.permission ?? undefined)
    )
      throw new AppError('FORBIDDEN', 'Tool unavailable or permission denied', 403);
    return tool;
  }
  list(p: Principal) {
    return this.store.transaction(p.organizationId, async (tx) =>
      (await tx.tools(p)).filter(
        (t) => t.connection_status === 'active' && canUse(p, t, t.permission ?? undefined),
      ),
    );
  }
  // Backward-compatible management adapter; execution/approval use semantic stores.
  policy(sql: Sql, org: string) {
    return postgresTransaction(sql, org).policy();
  }
  async call(p: Principal, name: string, args: JsonObject, key?: string, signal?: AbortSignal) {
    const id = randomUUID(),
      idempotencyKey = key ?? randomUUID();
    const fingerprint = hash(canonical({ name, args, user: p.userId, key: p.apiKeyId }));
    if (idempotencyKey.length > 160)
      throw new AppError('INVALID_IDEMPOTENCY_KEY', 'Idempotency key too long');
    const initial = await this.store.transaction(p.organizationId, async (tx) => {
      const existing = await tx.findByKey(idempotencyKey);
      if (existing) {
        if (existing.request_hash !== fingerprint)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key already used with another request',
            409,
          );
        return { execution: existing, dispatch: false };
      }
      let tool: ToolRecord | undefined,
        decision = { approval: false, reason: '' },
        failure: unknown;
      try {
        tool = await this.resolve(tx, p, name);
        validateInput(tool.input_schema, args);
        decision = await withSpan(
          'gateway.policy',
          { organizationId: p.organizationId, tool: name, risk: tool.risk },
          async () => evaluate(tool!, await tx.policy()),
        );
      } catch (e) {
        failure = e;
      }
      const status = failure ? 'denied' : decision.approval ? 'pending' : 'running';
      const execution = await tx.create({
        id,
        principal: p,
        name,
        toolId: tool?.id,
        redacted: failure ? { redacted: true } : redact(args, tool?.input_schema),
        encrypted: failure ? null : this.vault.seal(args, `${p.organizationId}:execution:${id}`),
        fingerprint,
        key: idempotencyKey,
        status,
        error: failure ? { ...publicError(failure), ...classifyFailure(failure, 'READ') } : null,
      });
      if (!execution) {
        const other = await tx.findByKey(idempotencyKey);
        if (!other || other.request_hash !== fingerprint)
          throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency conflict', 409);
        return { execution: other, dispatch: false };
      }
      await tx.step(id, 'authenticated');
      execution.trace_id = traceContext.getStore()?.traceId ?? newTraceId();
      execution.parent_span_id = traceContext.getStore()?.spanId;
      await tx.trace(id, execution.trace_id, execution.parent_span_id);
      await tx.step(id, failure ? 'denied' : 'policy_evaluated', { reason: decision.reason });
      if (decision.approval && tool)
        await tx.createApproval(id, tool.risk, decision.reason, p.userId);
      await tx.audit({
        principal: p,
        action: 'tool.requested',
        target: id,
        metadata: { tool: name, status },
      });
      return { execution, dispatch: status === 'running' };
    });
    if (initial.dispatch) return this.dispatch(initial.execution, p, signal);
    return this.response(initial.execution);
  }
  response(e: Execution) {
    return {
      executionId: e.id,
      traceId: e.trace_id,
      status: e.status,
      ...(e.result_metadata ? { result: e.result_metadata } : {}),
      ...(e.error_metadata ? { error: e.error_metadata } : {}),
    };
  }
  async dispatch(e: Execution, p: Principal, signal?: AbortSignal) {
    const started = Date.now();
    let risk: ToolRecord['risk'] = 'WRITE';
    let oauthConnection: string | undefined, usedToken: string | undefined;
    const events: { stage: string; metadata: Record<string, unknown> }[] = [];
    const flushTrace = async () => {
      if (events.length)
        await this.store.transaction(p.organizationId, async (tx) => {
          for (const event of events.splice(0))
            await tx.step(e.id, event.stage, {
              ...event.metadata,
              traceId: e.trace_id,
            });
        });
    };
    try {
      const current = await this.auth.refresh(p);
      const data = await this.store.transaction(p.organizationId, async (tx) => {
        const tool = await this.resolve(tx, current, e.tool_name);
        if (evaluate(tool, await tx.policy()).approval && !(await tx.approved(e.id)))
          throw new AppError(
            'APPROVAL_REQUIRED',
            'Policy changed before dispatch; submit a new request',
            409,
          );
        const { connection, ciphertext } = await tx.connection(tool.connection_id);
        await tx.step(e.id, 'dispatch_started');
        await tx.connector(e.id, connection.connector_id);
        return {
          tool,
          connection,
          secrets: ciphertext
            ? this.vault.open<Record<string, string>>(
                ciphertext,
                `${p.organizationId}:connection:${connection.id}`,
              )
            : {},
        };
      });
      const args = this.vault.open<JsonObject>(
        e.arguments_encrypted!,
        `${p.organizationId}:execution:${e.id}`,
      );
      validateInput(data.tool.input_schema, args);
      const required =
        typeof data.tool.config.requiredOAuthProvider === 'string'
          ? {
              provider: data.tool.config.requiredOAuthProvider,
              scopes: Array.isArray(data.tool.config.requiredOAuthScopes)
                ? data.tool.config.requiredOAuthScopes.filter(
                    (s): s is string => typeof s === 'string',
                  )
                : [],
            }
          : undefined;
      if (required && !this.oauth)
        throw new AppError('OAUTH_REAUTH_REQUIRED', 'OAuth is not configured', 403);
      const accessToken = await this.oauth?.accessToken(
        p.organizationId,
        data.connection.id,
        required,
      );
      if (accessToken) data.secrets.bearerToken = accessToken;
      oauthConnection = data.connection.id;
      usedToken = accessToken;
      risk =
        risks[Math.max(risks.indexOf(data.tool.risk), risks.indexOf(data.tool.baseline_risk))]!;
      const rawResult = await traceContext.run(
        {
          ...traceContext.getStore(),
          traceId: e.trace_id,
          spanId:
            traceContext.getStore()?.traceId === e.trace_id
              ? traceContext.getStore()?.spanId
              : e.parent_span_id,
          executionId: e.id,
          emit: (stage, metadata) => {
            if (events.length < 50) events.push({ stage, metadata });
          },
        },
        () =>
          withSpan(
            'gateway.dispatch',
            {
              organizationId: p.organizationId,
              connector: data.connection.connector_id,
              tool: data.tool.name,
              executionId: e.id,
            },
            () =>
              this.worker.dispatch(data.tool, args, {
                ...data,
                organizationId: p.organizationId,
                database: this.db,
                executionId: e.id,
                signal: signal
                  ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
                  : AbortSignal.timeout(30000),
              }),
          ),
      );
      const result = scrubSecrets(rawResult, Object.values(data.secrets));
      // Persist metadata only: results can contain provider secrets or personal data.
      const metadata = {
        bytes: Buffer.byteLength(JSON.stringify(result) ?? 'null'),
        type: Array.isArray(result) ? 'array' : typeof result,
      };
      if (metadata.bytes > 2 * 1024 * 1024)
        throw new AppError('RESPONSE_TOO_LARGE', 'Tool result exceeds 2 MiB');
      await flushTrace();
      await this.finish(e, p, 'succeeded', metadata, null, Date.now() - started);
      return {
        executionId: e.id,
        traceId: e.trace_id,
        status: 'succeeded',
        result,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === 'OAUTH_REAUTH_REQUIRED' &&
        oauthConnection &&
        usedToken
      )
        await this.oauth?.markReauth(p.organizationId, oauthConnection, usedToken);
      const safe = { ...publicError(error), ...classifyFailure(error, risk) };
      const status = safe.outcomeUnknown ? 'unknown' : 'failed';
      await flushTrace();
      await this.finish(e, p, status, null, safe, Date.now() - started);
      return {
        executionId: e.id,
        traceId: e.trace_id,
        status,
        error: safe,
        durationMs: Date.now() - started,
      };
    }
  }
  async finish(
    e: Execution,
    p: Principal,
    status: string,
    result: unknown,
    error: unknown,
    duration: number,
  ) {
    await this.store.transaction(p.organizationId, async (tx) => {
      await tx.finish(e.id, status, result, error, duration);
      await tx.step(e.id, status);
      await tx.audit({ principal: p, action: `tool.${status}`, target: e.id });
    });
    logger.info(
      {
        traceId: e.trace_id,
        executionId: e.id,
        organizationId: p.organizationId,
        status,
        durationMs: duration,
      },
      'Execution completed',
    );
  }
}
