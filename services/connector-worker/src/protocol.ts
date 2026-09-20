import type { Connection, JsonObject, ToolRecord } from '../../../packages/shared/src/index.js';
export interface ExecutionJob {
  version: 1;
  operation: 'catalog' | 'execute' | 'discover' | 'initialize' | 'test' | 'schema';
  executionId: string;
  traceId: string;
  organizationId?: string;
  connection?: Connection;
  secrets?: Record<string, string>;
  tool?: ToolRecord;
  arguments?: JsonObject;
}
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'trace'; stage: string; metadata: Record<string, unknown> }
  | { type: 'result'; result: unknown }
  | { type: 'error'; code: string };

/** Replace this transport with a queue/container adapter; connector handlers remain unchanged. */
export interface WorkerExecutor {
  run(job: ExecutionJob, signal?: AbortSignal): Promise<unknown>;
  health(): { status: string; active: number; waiting: number; crashes: number; capacity: number };
  close(): Promise<void>;
}
