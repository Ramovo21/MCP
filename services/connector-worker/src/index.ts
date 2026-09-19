import type {
  ConnectorRegistry,
  ConnectorContext,
} from '../../../packages/connector-sdk/src/index.js';
import type { ToolRecord, JsonObject } from '../../../packages/shared/src/index.js';
/** Synchronous worker boundary. Gateway owns authorization and durable execution claims. */
export class ConnectorWorker {
  constructor(private registry: ConnectorRegistry) {}
  async dispatch(tool: ToolRecord, args: JsonObject, ctx: ConnectorContext) {
    ctx.signal.throwIfAborted();
    return this.registry.get(ctx.connection.connector_id).execute(tool, args, ctx);
  }
}
