import { test, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { ExecutionService } from '../../apps/gateway/src/execution.js';
import { ConnectorWorker } from '../../services/connector-worker/src/index.js';
import { ConnectorRegistry, defineConnector } from '../../packages/connector-sdk/src/index.js';
import { AesGcmVault } from '../../packages/shared/src/secrets.js';
import type { Database } from '../../packages/database/src/index.js';
import type {
  ExecutionRecord,
  ExecutionStore,
  ExecutionTransaction,
} from '../../packages/shared/src/storage.js';
import { defaultPolicy } from '../../packages/policy-engine/src/index.js';
test('semantic storage injection executes and deduplicates without issuing SQL', async () => {
  const org = randomUUID(),
    connectionId = randomUUID();
  const principal = { organizationId: org, userId: randomUUID(), role: 'owner' as const };
  const records = new Map<string, ExecutionRecord>();
  const audit: string[] = [];
  const tool = {
    id: randomUUID(),
    organization_id: org,
    connection_id: connectionId,
    name: 'fixture.read',
    description: 'Return a fixture value.',
    input_schema: { type: 'object', additionalProperties: false },
    risk: 'READ' as const,
    baseline_risk: 'READ' as const,
    enabled: true,
    config: {},
    connection_status: 'active',
  };
  const unsupported = async (): Promise<never> => {
    throw Error('Unexpected storage operation');
  };
  const tx: ExecutionTransaction = {
    async tools(p, name) {
      return p.organizationId === org && (!name || name === tool.name) ? [tool] : [];
    },
    async policy() {
      return defaultPolicy;
    },
    async findByKey(key) {
      return records.get(key);
    },
    async create(i) {
      if (records.has(i.key)) return undefined;
      const e: ExecutionRecord = {
        id: i.id,
        organization_id: org,
        tool_id: i.toolId ?? null,
        tool_name: i.name,
        principal: i.principal,
        arguments_encrypted: i.encrypted,
        request_hash: i.fingerprint,
        status: i.status,
        result_metadata: null,
        error_metadata: null,
        started_at: new Date().toISOString(),
        trace_id: '',
      };
      records.set(i.key, e);
      return e;
    },
    async trace(id, traceId) {
      for (const e of records.values()) if (e.id === id) e.trace_id = traceId;
    },
    async step() {},
    async audit(e) {
      audit.push(e.action);
    },
    async connection(id) {
      if (id !== connectionId) throw Error('Wrong connection');
      return {
        connection: {
          id,
          organization_id: org,
          name: 'Fixture',
          connector_id: 'fixture',
          status: 'active',
          config: {},
        },
      };
    },
    async connector() {},
    async finish(id, status, result) {
      for (const e of records.values())
        if (e.id === id) {
          e.status = status;
          e.arguments_encrypted = null;
          e.result_metadata = result as Record<string, unknown>;
        }
    },
    createApproval: unsupported,
    approved: unsupported,
    lockApproval: unsupported,
    lockExecution: unsupported,
    decideApproval: unsupported,
  };
  const store: ExecutionStore = {
    async transaction(organization, fn) {
      if (organization !== org) throw Error('Wrong tenant');
      return fn(tx);
    },
  };
  const database: Database = {
    system: { query: unsupported },
    tenant: unsupported,
    async close() {},
  };
  const registry = new ConnectorRegistry().register(
    defineConnector({
      id: 'fixture',
      name: 'Fixture',
      version: '1.0.0',
      tools: [
        {
          namespace: 'fixture',
          name: 'read',
          description: tool.description,
          inputSchema: tool.input_schema,
          risk: 'READ',
          async execute() {
            return { value: 42 };
          },
        },
      ],
    }),
  );
  const service = new ExecutionService(
    database,
    new AesGcmVault(randomBytes(32).toString('base64')),
    new ConnectorWorker(registry),
    {
      async refresh(p) {
        return p;
      },
    },
    undefined,
    store,
  );
  expect((await service.call(principal, tool.name, {}, 'one')).result).toEqual({ value: 42 });
  expect((await service.call(principal, tool.name, {}, 'one')).status).toBe('succeeded');
  expect(records.size).toBe(1);
  expect(audit).toEqual(['tool.requested', 'tool.succeeded']);
  expect(records.get('one')?.arguments_encrypted).toBeNull();
});
