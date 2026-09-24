import type { Connection, JsonObject, Principal, ToolRecord } from './index.js';
import type { Policy } from '../../policy-engine/src/index.js';
export interface ExecutionRecord {
  id: string;
  organization_id: string;
  tool_id: string | null;
  tool_name: string;
  principal: Principal;
  arguments_encrypted: string | null;
  request_hash: string;
  status: string;
  result_metadata: JsonObject | null;
  error_metadata: JsonObject | null;
  started_at: string;
  trace_id: string;
  parent_span_id?: string;
}
export interface NewExecution {
  id: string;
  principal: Principal;
  name: string;
  toolId?: string;
  redacted: unknown;
  encrypted: string | null;
  fingerprint: string;
  key: string;
  status: string;
  error: unknown;
}
export interface ApprovalRecord {
  execution_id: string;
  status: string;
  requested_by: string | null;
  expires_at: string;
}
export interface AuditEvent {
  principal: Principal;
  action: string;
  target?: string;
  metadata?: unknown;
}
export interface AuditStore<TTransaction> {
  append(transaction: TTransaction, event: AuditEvent): Promise<void>;
}
export type AvailableTool = ToolRecord & { connection_status: string; permission?: boolean };
/** All methods operate in one verified tenant transaction. Implementations MUST roll back
 * on callback failure, atomically deduplicate create(), and lock approvals/executions.
 * Audit writes belong to the SAME transaction, not an eventual remote logger. */
export interface ExecutionTransaction {
  tools(principal: Principal, name?: string): Promise<AvailableTool[]>;
  policy(): Promise<Policy>;
  findByKey(key: string): Promise<ExecutionRecord | undefined>;
  create(input: NewExecution): Promise<ExecutionRecord | undefined>;
  trace(id: string, traceId: string, parentSpanId?: string): Promise<void>;
  step(id: string, stage: string, metadata?: unknown): Promise<void>;
  audit(event: AuditEvent): Promise<void>;
  createApproval(id: string, risk: string, reason: string, userId?: string): Promise<void>;
  approved(id: string): Promise<boolean>;
  connection(id: string): Promise<{ connection: Connection; ciphertext?: string }>;
  connector(id: string, connectorId: string): Promise<void>;
  finish(
    id: string,
    status: string,
    result: unknown,
    error: unknown,
    duration: number,
  ): Promise<void>;
  lockApproval(id: string): Promise<ApprovalRecord | undefined>;
  lockExecution(id: string): Promise<ExecutionRecord | undefined>;
  decideApproval(
    id: string,
    executionId: string,
    decision: 'approved' | 'rejected' | 'expired',
    userId?: string,
  ): Promise<void>;
}
export interface ExecutionStore {
  transaction<T>(organizationId: string, fn: (tx: ExecutionTransaction) => Promise<T>): Promise<T>;
}
