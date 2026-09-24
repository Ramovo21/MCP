import { defineConnector, type ConnectorContext } from '../../packages/connector-sdk/src/index.js';
import { SafeHttp } from '../../packages/shared/src/http.js';
import { AppError, type JsonObject } from '../../packages/shared/src/index.js';
const http = new SafeHttp({ privateHosts: ['127.0.0.1'], allowHttp: true });
async function request(ctx: ConnectorContext, path: string, method = 'GET', body?: JsonObject) {
  const base = new URL(String(ctx.connection.config.baseUrl));
  // Deliberately loopback-only example, never a production internal-network allowlist.
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:')
    throw new AppError('INVALID_CONNECTION', 'Example backend must be loopback HTTP');
  return http.json(new URL(path, base), {
    method,
    signal: ctx.signal,
    headers: {
      authorization: `Bearer ${ctx.secrets.backendToken}`,
      'content-type': 'application/json',
      'idempotency-key': ctx.executionId,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const idSchema = {
  type: 'object',
  properties: { id: { type: 'string', pattern: '^[a-zA-Z0-9-]{1,80}$' } },
  required: ['id'],
  additionalProperties: false,
};
export default defineConnector({
  id: 'simple-project',
  name: 'Simple project orders',
  version: '1.0.0',
  tools: [
    {
      namespace: 'customer',
      name: 'get',
      description: 'Get the local example customer by ID (customer-1).',
      risk: 'READ',
      inputSchema: idSchema,
      execute: (args, ctx) => request(ctx, `/customers/${String(args.id)}`),
    },
    {
      namespace: 'product',
      name: 'search',
      description: 'Search local example product names; returns IDs and prices.',
      risk: 'READ',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', maxLength: 100 } },
        additionalProperties: false,
      },
      execute: (args, ctx) =>
        request(ctx, `/products?query=${encodeURIComponent(String(args.query ?? ''))}`),
    },
    {
      namespace: 'order',
      name: 'create',
      description:
        'Create one example order for a customer and product. Writes data; obeys organization approval policy.',
      risk: 'WRITE',
      inputSchema: {
        type: 'object',
        properties: {
          customerId: { type: 'string', enum: ['customer-1'] },
          productId: { type: 'string', enum: ['product-1', 'product-2'] },
          quantity: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['customerId', 'productId', 'quantity'],
        additionalProperties: false,
      },
      execute: (args, ctx) => request(ctx, '/orders', 'POST', args),
    },
    {
      namespace: 'order',
      name: 'cancel',
      description:
        'Cancel an example order by its ID. CRITICAL: requires a different administrator to approve.',
      risk: 'CRITICAL',
      inputSchema: idSchema,
      execute: (args, ctx) => request(ctx, `/orders/${String(args.id)}`, 'DELETE'),
    },
  ],
});
