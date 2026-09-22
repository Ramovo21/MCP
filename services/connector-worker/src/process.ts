import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../packages/shared/src/index.js';
import {
  ConnectorRegistry,
  type ConnectorContext,
  type ToolDefinition,
} from '../../../packages/connector-sdk/src/index.js';
import { newTraceId, traceContext, traceEvent } from '../../../packages/shared/src/tracing.js';
import type { ExecutionJob, WorkerMessage, WorkerExecutor } from './protocol.js';

/** Bounded, one-job-per-process executor. IPC is private to the gateway; no public worker route. */
export class ProcessExecutor implements WorkerExecutor {
  private children = new Set<ChildProcess>();
  private waiting = 0;
  private closed = false;
  private crashes = 0;
  constructor(
    private options: {
      databaseUrl: string;
      concurrency?: number;
      timeoutMs?: number;
      module?: URL;
      env?: NodeJS.ProcessEnv;
    },
  ) {
    if (
      !Number.isInteger(options.concurrency ?? 4) ||
      (options.concurrency ?? 4) < 1 ||
      (options.concurrency ?? 4) > 16
    )
      throw new Error('WORKER_CONCURRENCY must be an integer from 1 to 16');
    if (
      !Number.isInteger(options.timeoutMs ?? 30000) ||
      (options.timeoutMs ?? 30000) < 100 ||
      (options.timeoutMs ?? 30000) > 30000
    )
      throw new Error('WORKER_TIMEOUT_MS must be between 100 and 30000');
  }
  health() {
    return {
      status: this.closed ? 'stopped' : 'ok',
      active: this.children.size,
      waiting: Math.max(0, this.waiting - this.children.size),
      crashes: this.crashes,
      capacity: this.options.concurrency ?? 4,
    };
  }
  async run(
    job: ExecutionJob,
    signal: AbortSignal = AbortSignal.timeout(this.options.timeoutMs ?? 30000),
  ): Promise<unknown> {
    if (this.closed) throw new AppError('WORKER_UNAVAILABLE', 'Worker is stopped', 503);
    if (this.waiting >= 64) throw new AppError('WORKER_BUSY', 'Worker capacity exhausted', 503);
    this.waiting++;
    try {
      while (this.children.size >= (this.options.concurrency ?? 4)) {
        signal.throwIfAborted();
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      signal.throwIfAborted();
      if (this.closed) throw new AppError('WORKER_UNAVAILABLE', 'Worker is stopped', 503);
      return await this.start(job, signal);
    } catch (error) {
      if (signal.aborted && !(error instanceof AppError))
        throw new AppError('WORKER_TIMEOUT', 'Worker deadline exceeded', 504);
      throw error;
    } finally {
      this.waiting--;
    }
  }
  private start(job: ExecutionJob, signal: AbortSignal): Promise<unknown> {
    const entry = this.options.module ?? new URL('./child.js', import.meta.url);
    const source = import.meta.url.endsWith('.ts');
    const path = fileURLToPath(
      source && !this.options.module ? new URL('./child.ts', import.meta.url) : entry,
    );
    // Deliberate environment allowlist: never inherit MASTER_KEY, Supabase admin keys or user tokens.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      NODE_ENV: process.env.NODE_ENV,
      DATABASE_URL: this.options.databaseUrl,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      CONNECTOR_PRIVATE_HOSTS: process.env.CONNECTOR_PRIVATE_HOSTS,
      CONNECTOR_INSECURE_PG_HOSTS: process.env.CONNECTOR_INSECURE_PG_HOSTS,
      CONNECTOR_MODULES: process.env.CONNECTOR_MODULES,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      APP_ENV: process.env.APP_ENV,
      ...this.options.env,
    };
    const child = fork(path, [], {
      execArgv: [...(source ? ['--import', 'tsx'] : []), '--max-old-space-size=192'],
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
    this.children.add(child);
    return new Promise((resolve, reject) => {
      let result: unknown,
        failure: AppError | undefined,
        received = false;
      const stop = (error: AppError) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const abort = () =>
        stop(new AppError('WORKER_CANCELLED', 'Worker cancelled or deadline exceeded', 504));
      const timer = setTimeout(
        () => stop(new AppError('WORKER_TIMEOUT', 'Worker deadline exceeded', 504)),
        this.options.timeoutMs ?? 30000,
      );
      signal.addEventListener('abort', abort, { once: true });
      child.on('message', (message: WorkerMessage) => {
        if (message.type === 'ready') child.send(job);
        else if (message.type === 'trace') traceEvent(message.stage, message.metadata);
        else if (message.type === 'result') {
          result = message.result;
          received = true;
        } else if (message.type === 'error') {
          failure = new AppError(message.code, 'Connector operation failed', 502);
          received = true;
        }
      });
      child.on('error', () =>
        stop(new AppError('CONNECTOR_FAILURE', 'Worker could not start', 503)),
      );
      child.on('close', () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.children.delete(child);
        if (!received && !failure) {
          this.crashes++;
          failure = new AppError('CONNECTOR_FAILURE', 'Connector process exited unexpectedly', 502);
        }
        if (failure) reject(failure);
        else resolve(result);
      });
    });
  }
  async close() {
    this.closed = true;
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once('close', () => resolve());
            child.kill('SIGKILL');
          }),
      ),
    );
  }
}

export async function processRegistry(executor: WorkerExecutor) {
  const catalog = (await executor.run({
    version: 1,
    operation: 'catalog',
    executionId: randomUUID(),
    traceId: newTraceId(),
  })) as { id: string; name: string; version: string; schema: boolean }[];
  const registry = new ConnectorRegistry();
  for (const metadata of catalog) {
    const run = (
      operation: ExecutionJob['operation'],
      ctx: ConnectorContext,
      tool?: ExecutionJob['tool'],
      args?: ExecutionJob['arguments'],
    ) =>
      executor.run(
        {
          version: 1,
          operation,
          executionId: ctx.executionId,
          traceId: traceContext.getStore()?.traceId ?? newTraceId(),
          parentSpanId: traceContext.getStore()?.spanId,
          organizationId: ctx.organizationId,
          connection: ctx.connection,
          secrets: ctx.secrets,
          tool,
          arguments: args,
        },
        ctx.signal,
      );
    registry.register({
      id: metadata.id,
      name: metadata.name,
      version: metadata.version,
      initialize: async (ctx) => {
        await run('initialize', ctx);
      },
      discover: async (ctx) => (await run('discover', ctx)) as ToolDefinition[],
      test: async (ctx) => {
        await run('test', ctx);
      },
      execute: (tool, args, ctx) => run('execute', ctx, tool, args),
      ...(metadata.schema ? { schema: (ctx: ConnectorContext) => run('schema', ctx) } : {}),
    });
  }
  return registry;
}
