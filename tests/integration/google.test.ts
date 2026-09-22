import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fixture } from '../helpers/fixture.js';
import {
  googleWorkspaceConnector,
  googleScopes,
} from '../../connectors/google-workspace/src/index.js';
import { googleOAuthProvider } from '../../connectors/google-workspace/src/oauth.js';
import { SafeHttp } from '../../packages/shared/src/http.js';
import { ConnectionService } from '../../apps/gateway/src/connections.js';
import { OAuthService } from '../../apps/gateway/src/oauth.js';
import { ExecutionService } from '../../apps/gateway/src/execution.js';
import { ConnectorWorker } from '../../services/connector-worker/src/index.js';

test('Google read tools use real HTTP fixture, PKCE, encrypted refresh, scopes, tenant binding and safe upstream failures', async () => {
  const f = await fixture();
  let status = 200,
    refreshes = 0,
    omitScope = true,
    timeout = false;
  const requests: { path: string; method: string; authorized: boolean }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    if (req.url === '/token') {
      const input = new URLSearchParams(body);
      if (input.get('grant_type') === 'refresh_token') refreshes++;
      else expect(input.get('code_verifier')?.length).toBeGreaterThan(40);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          access_token: 'private-google-access',
          refresh_token: 'private-google-refresh',
          token_type: 'Bearer',
          expires_in: refreshes ? 3600 : 1,
          ...(!omitScope ? { scope: Object.values(googleScopes).join(' ') } : {}),
        }),
      );
      return;
    }
    if (req.url === '/revoke') {
      res.end('{}');
      return;
    }
    requests.push({
      path: req.url!,
      method: req.method!,
      authorized: req.headers.authorization === 'Bearer private-google-access',
    });
    if (timeout) return;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        status === 200
          ? {
              messages: [{ id: 'message123', threadId: 'thread1' }],
              files: [{ id: 'file1' }],
              items: [{ id: 'event1' }],
            }
          : { error: 'private-google-access must never appear in an error' },
      ),
    );
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The only endpoint remapping lives in this test, never in runtime connector configuration.
  class FixtureHttp extends SafeHttp {
    constructor() {
      super({ privateHosts: ['127.0.0.1'], allowHttp: true });
    }
    override fetch(input: string | URL, init: RequestInit = {}) {
      const url = new URL(input);
      return super.fetch(base + url.pathname + url.search, {
        ...init,
        signal: AbortSignal.any([AbortSignal.timeout(300), ...(init.signal ? [init.signal] : [])]),
      });
    }
  }
  const http = new FixtureHttp(),
    provider = googleOAuthProvider('test-client', 'test-client-secret', http);
  const oauth = new OAuthService(f.db, f.vault, [provider], 'https://gateway.example');
  f.registry.register(googleWorkspaceConnector(http));
  const connections = new ConnectionService(f.db, f.vault, f.registry, oauth);
  const execution = new ExecutionService(
    f.db,
    f.vault,
    new ConnectorWorker(f.registry),
    f.auth,
    oauth,
  );
  try {
    await expect(
      oauth.initiate(f.principal, f.connection, provider.id, [googleScopes.gmail]),
    ).rejects.toMatchObject({ code: 'OAUTH_CONNECTOR_MISMATCH' });
    const connection = await connections.create(f.principal, {
      name: 'Google test account',
      connectorId: 'google-workspace',
      config: { services: ['gmail', 'drive', 'calendar'] },
      secrets: {},
    });
    const id = connection.id;
    const tools = await connections.discover(f.principal, id);
    expect(tools).toHaveLength(4);
    expect(tools.every((t) => t.risk === 'READ')).toBe(true);
    await connections.import(
      f.principal,
      id,
      tools.map((t) => `${t.namespace}.${t.name}`),
    );
    expect(
      (await execution.call(f.principal, 'google.gmail.email.search', { query: 'invoice' })).status,
    ).toBe('failed');
    const start = await oauth.initiate(f.principal, id, provider.id, Object.values(googleScopes));
    const authUrl = new URL(start.authorizationUrl);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('scope')).not.toMatch(/modify|send|full/);
    await oauth.callback(provider.id, authUrl.searchParams.get('state')!, 'fixture-code');
    const raw = JSON.stringify((await f.db.system.query('select * from oauth_tokens')).rows);
    expect(raw).not.toMatch(/private-google-access|private-google-refresh/);
    await expect(
      oauth.accessToken(randomUUID(), id, { provider: provider.id, scopes: [googleScopes.gmail] }),
    ).rejects.toMatchObject({ code: 'OAUTH_REAUTH_REQUIRED' });
    const result = await execution.call(f.principal, 'google.gmail.email.search', {
      query: 'invoice',
    });
    expect(result.status).toBe('succeeded');
    const recorded = (
      await f.db.system.query('select arguments_redacted from executions where id=$1', [
        result.executionId,
      ])
    ).rows[0]!;
    expect(recorded.arguments_redacted).toEqual({ query: '[REDACTED]' });
    expect(refreshes).toBe(1);
    expect(requests.at(-1)).toMatchObject({ method: 'GET', authorized: true });
    expect(requests.at(-1)?.path).toContain('q=invoice');
    for (const [name, args] of [
      ['google.gmail.email.get', { id: 'message123' }],
      ['google.drive.file.search', { query: "name contains 'invoice'" }],
      ['google.calendar.event.list', {}],
    ] as const)
      expect((await execution.call(f.principal, name, args)).status).toBe('succeeded');
    await connections.test(f.principal, id);
    for (const code of [403, 429, 500, 401]) {
      status = code;
      const failed = await execution.call(f.principal, 'google.gmail.email.search', {
        query: 'invoice',
      });
      expect(failed.status).toBe('failed');
      expect(JSON.stringify(failed)).not.toContain('private-google');
      expect((failed as { error: { code: string } }).error.code).toBe(
        code === 401
          ? 'OAUTH_REAUTH_REQUIRED'
          : code === 403
            ? 'UPSTREAM_PERMISSION'
            : 'UPSTREAM_TRANSIENT',
      );
    }
    expect(
      (await f.db.system.query('select status from oauth_tokens where connection_id=$1', [id]))
        .rows[0]?.status,
    ).toBe('reauth_required');
    status = 200;
    omitScope = false;
    const reconnect = await oauth.initiate(
      f.principal,
      id,
      provider.id,
      Object.values(googleScopes),
    );
    await oauth.callback(
      provider.id,
      new URL(reconnect.authorizationUrl).searchParams.get('state')!,
      'new-code',
    );
    timeout = true;
    const timed = await execution.call(f.principal, 'google.gmail.email.search', {
      query: 'invoice',
    });
    expect((timed as { error: { code: string } }).error.code).toBe('UPSTREAM_TIMEOUT');
    timeout = false;
    expect(
      (await execution.call(f.principal, 'google.gmail.email.search', { query: 'invoice' })).status,
    ).toBe('succeeded');
    await oauth.revoke(f.principal, id);
    expect(
      (await execution.call(f.principal, 'google.gmail.email.search', { query: 'invoice' })).status,
    ).toBe('failed');
    const logs = JSON.stringify((await f.db.system.query('select metadata from audit_logs')).rows);
    expect(logs).not.toMatch(/private-google-access|private-google-refresh|test-client-secret/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.db.close();
  }
}, 30000);
