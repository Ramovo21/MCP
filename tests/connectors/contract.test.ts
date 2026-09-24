import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Client } from 'pg';
import { config } from 'dotenv';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { fixture } from '../helpers/fixture.js';
import { testConnectorContract } from '../../packages/connector-sdk/src/testing.js';
import { ConnectionService } from '../../apps/gateway/src/connections.js';
import { demoCrm } from '../../connectors/demo-crm/src/index.js';
import { openApiConnector } from '../../connectors/openapi/src/index.js';
import { webhookConnector } from '../../connectors/webhook/src/index.js';
import { googleWorkspaceConnector } from '../../connectors/google-workspace/src/index.js';
import { remoteMcpConnector } from '../../connectors/remote-mcp/src/index.js';
import { postgresConnector } from '../../connectors/postgres/src/index.js';
import { SafeHttp } from '../../packages/shared/src/http.js';
config({ path: '.env', quiet: true });

for (const kind of [
  'demo-crm',
  'openapi',
  'webhook',
  'google-workspace',
  'remote-mcp',
  'postgres',
] as const) {
  test(`connector contract: ${kind}`, async () => {
    const f = await fixture();
    let receivedKey = '',
      admin: Client | undefined,
      target: Client | undefined;
    const database = 'omnimcp_contract_' + randomUUID().replaceAll('-', '');
    const handler = createMcpHandler(
      async () => {
        const s = new Server(
          { name: 'independent-contract-upstream', version: '1.0.0' },
          { capabilities: { tools: {} }, supportedProtocolVersions: ['2026-07-28'] },
        );
        s.setRequestHandler('tools/list', async () => ({
          tools: [
            {
              name: 'echo',
              description: 'Return local fixture data.',
              inputSchema: { type: 'object', additionalProperties: false },
            },
          ],
        }));
        s.setRequestHandler('tools/call', async (req) => {
          receivedKey = String(req.params._meta?.['omnimcp/idempotencyKey']);
          return { content: [{ type: 'text', text: 'customer-1' }] };
        });
        return s;
      },
      { legacy: 'reject' },
    );
    const upstream = createServer((req, res) => {
      if (req.url === '/mcp') {
        void toNodeHandler(handler)(req, res);
        return;
      }
      receivedKey = String(req.headers['idempotency-key'] ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'customer-1', echo: req.headers.authorization ?? 'none' }));
    }).listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw Error('No address');
    const url = `http://127.0.0.1:${address.port}`;
    const http = new SafeHttp({ privateHosts: ['127.0.0.1'], allowHttp: true });
    const ctx = await new ConnectionService(f.db, f.vault, f.registry).context(
      f.principal,
      f.connection,
    );
    ctx.signal = AbortSignal.timeout(25000);
    ctx.connection = { ...ctx.connection, connector_id: kind };
    ctx.secrets = {
      bearerToken: 'contract-secret-value',
      signingSecret: 'contract-signing-value'.repeat(3),
    };
    try {
      let connector = demoCrm,
        name = 'demo.crm.customer.search',
        args: Record<string, unknown> = {};
      if (kind === 'openapi') {
        connector = openApiConnector(http);
        name = 'customer.get';
        ctx.connection.config = {
          baseUrl: url,
          namespace: 'customer',
          spec: {
            openapi: '3.1.0',
            paths: {
              '/customers': {
                get: { operationId: 'get' },
                post: { operationId: 'create' },
                delete: { operationId: 'delete' },
              },
            },
          },
        };
        expect((await connector.discover(ctx)).map((t) => t.risk)).toEqual([
          'READ',
          'WRITE',
          'CRITICAL',
        ]);
      } else if (kind === 'webhook') {
        connector = webhookConnector(http);
        name = 'webhook.send';
        args = { event: 'contract', payload: {} };
        ctx.connection.config = { url };
      } else if (kind === 'google-workspace') {
        class GoogleFixtureHttp extends SafeHttp {
          override fetch(_url: string | URL, init: RequestInit = {}) {
            return http.fetch(url, init);
          }
        }
        connector = googleWorkspaceConnector(new GoogleFixtureHttp());
        name = 'google.gmail.email.search';
        args = { query: 'fixture' };
        ctx.connection.config = { services: ['gmail', 'drive', 'calendar'] };
      } else if (kind === 'remote-mcp') {
        connector = remoteMcpConnector(http);
        name = 'remote.echo';
        ctx.connection.config = { url: url + '/mcp', namespace: 'remote' };
      } else if (kind === 'postgres') {
        if (!process.env.DATABASE_URL)
          throw Error(
            'Postgres contract needs local DATABASE_URL; run pnpm db:start and pnpm env:local',
          );
        const base = new URL(process.env.DATABASE_URL);
        if (!['localhost', '127.0.0.1'].includes(base.hostname))
          throw Error('Disposable contract database must be local');
        admin = new Client({ connectionString: base.href });
        await admin.connect();
        await admin.query(`create database "${database}"`);
        base.pathname = '/' + database;
        ctx.secrets = { databaseUrl: base.href };
        target = new Client({ connectionString: base.href });
        await target.connect();
        await target.query(
          "create table customers(id text primary key);insert into customers values('customer-1')",
        );
        connector = postgresConnector({
          privateHosts: [base.hostname],
          insecurePgHosts: [base.hostname],
        });
        name = 'postgres.public.customers.search';
        ctx.connection.config = {
          tables: [
            { schema: 'public', table: 'customers', columns: ['id'], operations: ['search'] },
          ],
        };
      }
      const report = await testConnectorContract(connector, {
        context: ctx,
        toolName: name,
        arguments: args,
        assertResult(result) {
          expect(JSON.stringify(result)).toContain(
            kind === 'demo-crm' ? 'Ada Nguyen' : 'customer-1',
          );
        },
        ...(['openapi', 'webhook', 'remote-mcp'].includes(kind)
          ? {
              assertIdempotency(id: string) {
                expect(receivedKey).toBe(id);
              },
            }
          : {}),
      });
      expect(report.checks.length).toBeGreaterThanOrEqual(11);
    } finally {
      await target?.end();
      if (admin) {
        await admin.query(`drop database if exists "${database}"`);
        await admin.end();
      }
      upstream.closeAllConnections();
      await new Promise<void>((r) => upstream.close(() => r()));
      await handler.close();
      await f.db.close();
    }
  });
}
