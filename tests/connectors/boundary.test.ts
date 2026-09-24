import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { defineConnector, type ConnectorContext } from '../../packages/connector-sdk/src/index.js';
import {
  executeConnector,
  validateDefinitions,
} from '../../packages/connector-sdk/src/contract.js';
import type { Database } from '../../packages/database/src/index.js';
import type { ToolRecord } from '../../packages/shared/src/index.js';
const db: Database = {
  system: {
    async query() {
      throw Error('Unexpected SQL');
    },
  },
  async tenant() {
    throw Error('Unexpected SQL');
  },
  async close() {},
};
const ctx: ConnectorContext = {
  organizationId: randomUUID(),
  connection: {
    id: randomUUID(),
    organization_id: '',
    connector_id: 'boundary',
    name: 'Boundary',
    status: 'active',
    config: {},
  },
  database: db,
  secrets: { token: 'sensitive-value' },
  executionId: randomUUID(),
  signal: new AbortController().signal,
};
ctx.connection.organization_id = ctx.organizationId;
const tool: ToolRecord = {
  id: randomUUID(),
  organization_id: ctx.organizationId,
  connection_id: ctx.connection.id,
  name: 'contract.get',
  description: 'Boundary fixture.',
  input_schema: { type: 'object' },
  risk: 'READ',
  baseline_risk: 'READ',
  enabled: true,
  config: {},
};
function connector(
  execute: (args: Record<string, unknown>, ctx: ConnectorContext) => Promise<unknown>,
) {
  return defineConnector({
    id: 'boundary',
    name: 'Boundary',
    version: '1.0.0',
    tools: [
      {
        namespace: 'contract',
        name: 'get',
        description: tool.description,
        inputSchema: tool.input_schema,
        risk: 'READ',
        execute,
      },
    ],
  });
}
test('contract rejects duplicate metadata, invalid risk, invalid input and output schemas', () => {
  const valid = {
    namespace: 'contract',
    name: 'get',
    description: 'Fixture',
    inputSchema: { type: 'object' },
    risk: 'READ' as const,
  };
  expect(() => validateDefinitions([valid, valid])).toThrow();
  expect(() => validateDefinitions([{ ...valid, inputSchema: { type: 'wrong' } }])).toThrow();
  expect(() => validateDefinitions([{ ...valid, outputSchema: { type: 'wrong' } }])).toThrow();
  expect(() => validateDefinitions([{ ...valid, risk: 'UNSAFE' as 'READ' }])).toThrow();
});
test('worker boundary scrubs successful results and suppresses sensitive error messages', async () => {
  expect(
    await executeConnector(
      connector(async () => ({ nested: 'sensitive-value' })),
      tool,
      {},
      ctx,
    ),
  ).toEqual({ nested: '[REDACTED]' });
  await expect(
    executeConnector(
      connector(async () => {
        throw Error('sensitive-value');
      }),
      tool,
      {},
      ctx,
    ),
  ).rejects.toMatchObject({ code: 'CONNECTOR_FAILURE', message: 'Connector operation failed' });
});
test('bounded output and JSON serialization are enforced', async () => {
  await expect(
    executeConnector(
      connector(async () => ({ value: 'x'.repeat(1000) })),
      tool,
      {},
      ctx,
      { maxBytes: 100 },
    ),
  ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  await expect(
    executeConnector(
      connector(async () => undefined),
      tool,
      {},
      ctx,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
test('deadline reaches connector AbortSignal and stops waiting without retrying effects', async () => {
  let calls = 0,
    aborted = false;
  const c = connector(async (_args, context) => {
    calls++;
    return new Promise((_resolve, reject) =>
      context.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(Error('cancelled'));
        },
        { once: true },
      ),
    );
  });
  await expect(executeConnector(c, tool, {}, ctx, { timeoutMs: 30 })).rejects.toMatchObject({
    code: 'WORKER_CANCELLED',
  });
  expect(calls).toBe(1);
  expect(aborted).toBe(true);
});
