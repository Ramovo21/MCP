import type { Database } from '../../database/src/index.js';
import {
  AppError,
  toolName,
  type Connection,
  type JsonObject,
  type Risk,
  type ToolRecord,
} from '../../shared/src/index.js';
export interface ConnectorContext {
  organizationId: string;
  connection: Connection;
  secrets: Record<string, string>;
  database: Database;
  executionId: string;
  signal: AbortSignal;
}
export interface ToolDefinition {
  namespace: string;
  name: string;
  description: string;
  inputSchema: JsonObject;
  risk: Risk;
  config?: JsonObject;
  execute?: (args: JsonObject, ctx: ConnectorContext) => Promise<unknown>;
}
export interface Connector {
  id: string;
  name: string;
  version: string;
  initialize?(ctx: ConnectorContext): Promise<void>;
  discover(ctx: ConnectorContext): Promise<ToolDefinition[]>;
  execute(tool: ToolRecord, args: JsonObject, ctx: ConnectorContext): Promise<unknown>;
  test?(ctx: ConnectorContext): Promise<void>;
}
export function defineConnector(
  def: Omit<Connector, 'discover' | 'execute'> & { tools: ToolDefinition[] },
): Connector {
  for (const t of def.tools) toolName.parse(`${t.namespace}.${t.name}`);
  return {
    ...def,
    async discover() {
      return def.tools.map(({ execute: _handler, ...t }) => t);
    },
    async execute(tool, args, ctx) {
      const t = def.tools.find((t) => `${t.namespace}.${t.name}` === tool.name);
      if (!t?.execute) throw new AppError('TOOL_NOT_FOUND', 'Connector tool is unavailable', 404);
      return t.execute(args, ctx);
    },
  };
}
export class ConnectorRegistry {
  private plugins = new Map<string, Connector>();
  register(connector: Connector) {
    if (this.plugins.has(connector.id)) throw new Error('Duplicate connector ' + connector.id);
    this.plugins.set(connector.id, connector);
    return this;
  }
  get(id: string) {
    const connector = this.plugins.get(id);
    if (!connector) throw new AppError('CONNECTOR_NOT_FOUND', 'Connector is not installed', 404);
    return connector;
  }
  list() {
    return [...this.plugins.values()].map(({ id, name, version }) => ({ id, name, version }));
  }
}
/** Reserved extension boundary; no browser implementation is shipped or enabled in V1. */
export interface BrowserAutomationExtension {
  kind: 'browser-automation';
  apiVersion: 1;
  createIsolatedConnector(): Promise<Connector>;
}
