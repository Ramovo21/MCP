import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import express from 'express';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { fixtureTls } from './tls.js';

export async function upstreams() {
  const tls = await fixtureTls();
  const app = express();
  app.use(express.json());
  const customers = new Map([['1', { id: '1', name: 'Independent REST customer' }]]);
  const writes: string[] = [],
    traces: string[] = [];
  app.use((req, _res, next) => {
    if (req.get('traceparent')) traces.push(req.get('traceparent')!);
    next();
  });
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  const spec = {
    openapi: '3.1.0',
    info: { title: 'Audit REST API', version: '1' },
    paths: {
      '/customers': {
        get: { operationId: 'customers.list', summary: 'List customers' },
        post: {
          operationId: 'customers.create',
          summary: 'Create a customer',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name'],
                  additionalProperties: false,
                },
              },
            },
          },
        },
      },
      '/customers/{id}': {
        get: { operationId: 'customers.get', parameters: [id] },
        delete: { operationId: 'customers.delete', parameters: [id] },
      },
      '/fail/{id}': { get: { operationId: 'failure.get', parameters: [id] } },
      '/echo': { get: { operationId: 'echo.get' } },
    },
  };
  app.get('/openapi.json', (_req, res) => res.json(spec));
  app.get('/customers', (_req, res) => res.json([...customers.values()]));
  app.get('/customers/:id', (req, res) => res.json(customers.get(String(req.params.id)) ?? null));
  app.post('/customers', (req, res) => {
    const id = String(customers.size + 1);
    customers.set(id, { id, name: req.body.name });
    writes.push(req.get('idempotency-key') ?? 'missing');
    res.status(201).json(customers.get(id));
  });
  app.delete('/customers/:id', (req, res) => {
    customers.delete(String(req.params.id));
    writes.push(req.get('idempotency-key') ?? 'missing');
    res.sendStatus(204);
  });
  app.get('/fail/:id', (req, res) =>
    res.status(Number(req.params.id)).json({ error: 'secret upstream detail never persisted' }),
  );
  app.get('/echo', (req, res) => res.json({ unexpectedField: req.get('authorization') }));
  app.get('/redirect', (_req, res) => res.redirect('http://169.254.169.254/latest/meta-data/'));
  const handler = createMcpHandler(
    () => {
      const server = new Server(
        { name: 'Independent audit upstream', version: '1' },
        { capabilities: { tools: {} }, supportedProtocolVersions: ['2026-07-28'] },
      );
      server.setRequestHandler('tools/list', async () => ({
        tools: [
          {
            name: 'lookup',
            description: 'Independent fixture lookup',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              additionalProperties: false,
            },
          },
        ],
      }));
      server.setRequestHandler('tools/call', async () => ({
        content: [{ type: 'text', text: 'Independent MCP response' }],
      }));
      return server;
    },
    { legacy: 'reject', responseMode: 'auto' },
  );
  app.all('/mcp', async (req, res) => {
    await toNodeHandler(handler)(req, res, req.body);
  });
  const server = createServer(
    {
      key: readFileSync(tls.key),
      cert: readFileSync(tls.cert),
    },
    app,
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return {
    certificatePath: tls.cert,
    url: `https://127.0.0.1:${address.port}`,
    customers,
    writes,
    traces,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await tls.close();
    },
  };
}
