import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Connector, ConnectorContext } from './index.js';
import type { JsonObject, ToolRecord } from '../../shared/src/index.js';
import { executeConnector, validateConnectorMetadata, validateDefinitions } from './contract.js';

/** Reusable behavior contract. Supply a real local upstream and semantic result
 * assertion. Network credentials/fixtures are supplied by the caller, never logged. */
export async function testConnectorContract(
  connector: Connector,
  options: {
    context: ConnectorContext;
    toolName: string;
    arguments: JsonObject;
    assertResult(result: unknown): void | Promise<void>;
    assertIdempotency?(executionId: string): void | Promise<void>;
  },
) {
  validateConnectorMetadata(connector);
  const ctx = options.context;
  const tools = await connector.discover(ctx);
  validateDefinitions(tools);
  assert.ok(tools.length, 'Fixture must expose at least one tool');
  const definition = tools.find((t) => `${t.namespace}.${t.name}` === options.toolName);
  assert.ok(definition, 'Expected selected tool');
  const tool: ToolRecord = {
    id: randomUUID(),
    organization_id: ctx.organizationId,
    connection_id: ctx.connection.id,
    name: options.toolName,
    description: definition.description,
    input_schema: definition.inputSchema,
    risk: definition.risk,
    baseline_risk: definition.risk,
    enabled: true,
    config: definition.config ?? {},
  };
  const result = await executeConnector(connector, tool, options.arguments, ctx);
  assert.doesNotThrow(() => JSON.stringify(result));
  for (const secret of Object.values(ctx.secrets).filter((v) => v.length >= 8))
    assert.ok(!JSON.stringify(result).includes(secret), 'Result must not expose a credential');
  await options.assertResult(result);
  await options.assertIdempotency?.(ctx.executionId);
  await assert.rejects(
    executeConnector(connector, { ...tool, name: 'contract.unknown' }, options.arguments, ctx),
    { code: 'TOOL_NOT_FOUND' },
  );
  await assert.rejects(
    executeConnector(connector, tool, options.arguments, { ...ctx, signal: AbortSignal.abort() }),
    { code: 'WORKER_CANCELLED' },
  );
  await assert.rejects(
    executeConnector(connector, { ...tool, organization_id: randomUUID() }, options.arguments, ctx),
    { code: 'INVALID_JOB' },
  );
  return {
    connector: connector.id,
    discovered: tools.length,
    checks: [
      'metadata',
      'unique names',
      'schemas',
      'risks',
      'discovery',
      'execution',
      'result assertion',
      'redaction',
      'unknown tool',
      'abort',
      'tenant binding',
      ...(options.assertIdempotency ? ['idempotency'] : []),
    ],
  };
}
