import {
  AppError,
  risks,
  toolName,
  type ToolRecord,
  type JsonObject,
} from '../../shared/src/index.js';
import { validateInput, validateToolSchema } from '../../mcp-core/src/validation.js';
import { canonical, scrubSecrets } from '../../shared/src/secrets.js';
import type { Connector, ConnectorContext, ToolDefinition } from './index.js';

export function validateConnectorMetadata(connector: Connector) {
  if (
    !connector ||
    !/^[a-z][a-z0-9-]{0,79}$/.test(connector.id) ||
    !connector.name?.trim() ||
    typeof connector.version !== 'string' ||
    !connector.version.trim() ||
    connector.version.length > 80 ||
    typeof connector.discover !== 'function' ||
    typeof connector.execute !== 'function'
  )
    throw new AppError('INVALID_CONNECTOR', 'Connector metadata is invalid');
}
export function validateDefinitions(tools: ToolDefinition[]) {
  if (!Array.isArray(tools) || tools.length > 500)
    throw new AppError('INVALID_CONNECTOR', 'Connector tool limit is 500');
  const names = new Set<string>();
  for (const t of tools) {
    const name = toolName.parse(`${t.namespace}.${t.name}`);
    if (names.has(name) || !t.description?.trim() || !risks.includes(t.risk))
      throw new AppError('INVALID_CONNECTOR', 'Invalid or duplicate tool metadata');
    names.add(name);
    validateToolSchema(t.inputSchema);
    if (t.outputSchema) validateToolSchema(t.outputSchema);
  }
}
/** Worker-bound contract enforcement. Hard termination is the process executor's job;
 * abort racing alone cannot undo an upstream effect or stop malicious plugin code. */
export async function executeConnector(
  connector: Connector,
  tool: ToolRecord,
  args: JsonObject,
  context: ConnectorContext,
  options: { timeoutMs?: number; maxBytes?: number } = {},
) {
  validateConnectorMetadata(connector);
  if (
    context.organizationId !== context.connection.organization_id ||
    tool.organization_id !== context.organizationId ||
    tool.connection_id !== context.connection.id ||
    connector.id !== context.connection.connector_id
  )
    throw new AppError('INVALID_JOB', 'Connector tenant or connection binding mismatch');
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs ?? 30000)]);
  let abort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(new AppError('WORKER_CANCELLED', 'Connector cancelled or deadline exceeded', 504));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    if (signal.aborted)
      throw new AppError('WORKER_CANCELLED', 'Connector cancelled or deadline exceeded', 504);
    return await Promise.race([
      cancelled,
      (async () => {
        const ctx = { ...context, signal };
        const definitions = await connector.discover(ctx);
        validateDefinitions(definitions);
        const definition = definitions.find((t) => `${t.namespace}.${t.name}` === tool.name);
        if (!definition) throw new AppError('TOOL_NOT_FOUND', 'Connector tool is unavailable', 404);
        if (risks.indexOf(tool.baseline_risk) < risks.indexOf(definition.risk))
          throw new AppError('INVALID_TOOL', 'Connector risk changed; reimport the tool');
        // Registry metadata cannot manufacture an operation absent from discovery.
        if (canonical(definition.config ?? {}) !== canonical(tool.config))
          throw new AppError('INVALID_TOOL', 'Connector metadata changed; reimport the tool');
        validateInput(definition.inputSchema, args);
        signal.throwIfAborted();
        const raw = await connector.execute(tool, args, ctx);
        const result = scrubSecrets(raw, Object.values(ctx.secrets));
        const encoded = JSON.stringify(result);
        if (encoded === undefined)
          throw new AppError('INVALID_RESPONSE', 'Connector must return JSON data');
        if (Buffer.byteLength(encoded) > (options.maxBytes ?? 2 * 1024 * 1024))
          throw new AppError('RESPONSE_TOO_LARGE', 'Connector result exceeds its limit');
        if (definition.outputSchema) validateInput(definition.outputSchema, result);
        return result;
      })(),
    ]);
  } catch (error) {
    throw new AppError(
      error instanceof AppError && /^[A-Z_]{1,80}$/.test(error.code)
        ? error.code
        : 'CONNECTOR_FAILURE',
      'Connector operation failed',
      error instanceof AppError ? error.status : 502,
    );
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
