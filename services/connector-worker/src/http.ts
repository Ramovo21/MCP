import express from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../../packages/shared/src/index.js';
import { traceContext, traceEvent } from '../../../packages/shared/src/tracing.js';
import type { ExecutionJob, WorkerExecutor } from './protocol.js';
import { withSpan } from '../../../packages/shared/src/telemetry.js';

const jobSchema = z
  .object({
    version: z.literal(1),
    operation: z.enum(['catalog', 'execute', 'discover', 'initialize', 'test', 'schema']),
    executionId: z.uuid(),
    traceId: z.string().regex(/^[a-f0-9]{32}$/),
    parentSpanId: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional(),
    organizationId: z.uuid().optional(),
    connection: z.record(z.string(), z.unknown()).optional(),
    secrets: z.record(z.string(), z.string()).optional(),
    tool: z.record(z.string(), z.unknown()).optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export function workerApp(
  executor: WorkerExecutor,
  token: string,
  ready: () => Promise<void>,
): express.Express {
  if (token.length < 32)
    throw new Error('Worker authentication token must have at least 32 characters');
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'connector-worker' }));
  app.use((req, res, next) => {
    const digest = (v: string) => createHash('sha256').update(v).digest();
    if (!timingSafeEqual(digest(req.get('authorization') ?? ''), digest('Bearer ' + token))) {
      res.status(401).json({ code: 'UNAUTHORIZED' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/ready', async (_req, res) => {
    try {
      await ready();
      const health = executor.health();
      res.status(health.status === 'ok' ? 200 : 503).json(health);
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.use(express.json({ limit: '1mb' }));
  app.post('/jobs', async (req, res) => {
    const parsed = jobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_JOB' });
      return;
    }
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', cancel);
    const events: { stage: string; metadata: Record<string, unknown> }[] = [];
    try {
      const result = await traceContext.run(
        {
          traceId: parsed.data.traceId,
          spanId: parsed.data.parentSpanId,
          executionId: parsed.data.executionId,
          emit: (stage, metadata) => {
            if (events.length < 50) events.push({ stage, metadata });
          },
        },
        () =>
          withSpan(
            'worker.job',
            {
              operation: parsed.data.operation,
              organizationId: parsed.data.organizationId,
              executionId: parsed.data.executionId,
            },
            () =>
              executor.run(
                { ...parsed.data, parentSpanId: traceContext.getStore()?.spanId } as ExecutionJob,
                AbortSignal.any([controller.signal, AbortSignal.timeout(32000)]),
              ),
          ),
      );
      res.json({ result, events });
    } catch (error) {
      res.status(502).json({
        code:
          error instanceof AppError && /^[A-Z_]{1,80}$/.test(error.code)
            ? error.code
            : 'CONNECTOR_FAILURE',
        events,
      });
    } finally {
      res.off('close', cancel);
    }
  });
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ code: 'INVALID_JOB' });
    },
  );
  return app;
}

/** Trusted private service transport. No automatic retry, including ambiguous writes. */
export class HttpWorkerExecutor implements WorkerExecutor {
  private state = { status: 'unknown', active: 0, waiting: 0, crashes: 0, capacity: 0 };
  constructor(
    private url: string,
    private token: string,
  ) {
    const u = new URL(url);
    if (
      !['https:', 'http:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/'
    )
      throw new Error('Invalid WORKER_URL');
    if (token.length < 32) throw new Error('Invalid WORKER_AUTH_TOKEN');
  }
  health() {
    return this.state;
  }
  async ready() {
    try {
      const response = await fetch(new URL('/ready', this.url), {
        headers: { authorization: 'Bearer ' + this.token },
        signal: AbortSignal.timeout(6000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Worker not ready');
      this.state = z
        .object({
          status: z.string(),
          active: z.number(),
          waiting: z.number(),
          crashes: z.number(),
          capacity: z.number(),
        })
        .parse(await response.json());
    } catch {
      this.state = { ...this.state, status: 'unavailable' };
      throw new AppError('WORKER_UNAVAILABLE', 'Worker unavailable', 503);
    }
  }
  async run(job: ExecutionJob, signal?: AbortSignal) {
    try {
      const response = await fetch(new URL('/jobs', this.url), {
        method: 'POST',
        headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' },
        body: JSON.stringify(job),
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(35000), ...(signal ? [signal] : [])]),
      });
      // Bound even a faulty worker response before parsing it.
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 3 * 1024 * 1024) {
            await reader.cancel();
            throw new AppError('RESPONSE_TOO_LARGE', 'Worker result too large', 502);
          }
          chunks.push(value);
        }
      const data = JSON.parse(Buffer.concat(chunks).toString()) as {
        result?: unknown;
        code?: string;
        events?: { stage: string; metadata: Record<string, unknown> }[];
      };
      for (const event of data.events?.slice(0, 50) ?? []) traceEvent(event.stage, event.metadata);
      if (!response.ok)
        throw new AppError(
          data.code && /^[A-Z_]{1,80}$/.test(data.code) ? data.code : 'CONNECTOR_FAILURE',
          'Connector operation failed',
          502,
        );
      return data.result;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(
        signal?.aborted ? 'WORKER_CANCELLED' : 'WORKER_UNAVAILABLE',
        'Worker request failed; execution may have started',
        503,
      );
    }
  }
  async close() {
    this.state = { ...this.state, status: 'stopped' };
  }
}
