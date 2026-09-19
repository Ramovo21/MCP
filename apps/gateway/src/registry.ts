import { ConnectorRegistry, type Connector } from '../../../packages/connector-sdk/src/index.js';
import { SafeHttp } from '../../../packages/shared/src/http.js';
import { demoCrm } from '../../../connectors/demo-crm/src/index.js';
import { openApiConnector } from '../../../connectors/openapi/src/index.js';
import { postgresConnector } from '../../../connectors/postgres/src/index.js';
import { remoteMcpConnector } from '../../../connectors/remote-mcp/src/index.js';
import { webhookConnector } from '../../../connectors/webhook/src/index.js';
export async function loadRegistry() {
  const policy = {
      insecurePgHosts: (process.env.CONNECTOR_INSECURE_PG_HOSTS ?? '').split(',').filter(Boolean),
      privateHosts: (process.env.CONNECTOR_PRIVATE_HOSTS ?? '').split(',').filter(Boolean),
    },
    http = new SafeHttp(policy);
  const registry = new ConnectorRegistry()
    .register(demoCrm)
    .register(openApiConnector(http))
    .register(postgresConnector(policy))
    .register(remoteMcpConnector(http))
    .register(webhookConnector(http));
  for (const url of (process.env.CONNECTOR_MODULES ?? '').split(',').filter(Boolean)) {
    const module = (await import(url)) as { default: Connector };
    registry.register(module.default);
  }
  return registry;
}
