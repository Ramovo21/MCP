import { beforeAll, afterAll, test, expect } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { dirname, resolve } from 'node:path';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MissingRequiredClientCapabilityError } from '@modelcontextprotocol/server';
import { handleMcp, type GatewayDispatcher } from '../../packages/mcp-core/src/index.js';
import { validateInput } from '../../packages/mcp-core/src/validation.js';
import { AppError, type ToolRecord } from '../../packages/shared/src/index.js';

let server: Server, url: string;
let cancellationObserved = false;
const principal = { organizationId: 'conformance', userId: 'fixture', role: 'developer' as const };
const definition: ToolRecord = {
  id: 'fixture',
  organization_id: principal.organizationId,
  connection_id: 'fixture',
  name: 'fixture.echo',
  description: 'Echo a bounded test message.',
  enabled: true,
  risk: 'READ',
  baseline_risk: 'READ',
  config: {},
  input_schema: {
    type: 'object',
    properties: { message: { type: 'string', maxLength: 100 } },
    additionalProperties: false,
  },
};
const dispatcher: GatewayDispatcher = {
  async list() {
    return [definition, { ...definition, name: 'test_missing_capability' }];
  },
  async call(_principal, name, args, _key, signal) {
    if (name === 'test_missing_capability')
      throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { sampling: {} } });
    if (name === 'fixture.wait') {
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(new Error('cancelled'));
        else
          signal?.addEventListener(
            'abort',
            () => {
              cancellationObserved = true;
              reject(new Error('cancelled'));
            },
            { once: true },
          );
      });
    }
    if (name === 'test_error_handling') throw new Error('private fixture credential');
    if (name !== definition.name && name !== 'test_simple_text')
      throw new AppError('TOOL_NOT_FOUND', 'Unknown tool', 404);
    validateInput(definition.input_schema, args);
    return { status: 'succeeded', result: args };
  },
};
beforeAll(async () => {
  // Loopback-only protocol fixture, not a production authentication switch.
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.all('/mcp', (req, res) => handleMcp(req, res, principal, dispatcher));
  app.use(
    (
      error: { type?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid request' });
    },
  );
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  url = `http://127.0.0.1:${address.port}/mcp`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function client() {
  const c = new Client(
    { name: 'conformance', version: '1' },
    { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return c;
}
test('modern discovery, namespaced list, JSON schema and structured call using official v2 client', async () => {
  const c = await client();
  try {
    expect(c.getDiscoverResult()?.supportedVersions).toContain('2026-07-28');
    expect(c.getServerCapabilities()).toEqual({ tools: {} });
    const list = await c.listTools();
    expect(list.tools[0]).toMatchObject({
      name: definition.name,
      inputSchema: definition.input_schema,
    });
    expect(list.nextCursor).toBeUndefined();
    const result = await c.callTool({ name: definition.name, arguments: { message: 'hello' } });
    expect(result.structuredContent).toMatchObject({
      status: 'succeeded',
      result: { message: 'hello' },
    });
  } finally {
    await c.close();
  }
});
test('tool errors and invalid arguments remain sanitized MCP tool results', async () => {
  const c = await client();
  try {
    for (const [name, args] of [
      ['unknown.tool', {}],
      [definition.name, { message: 12 }],
      ['test_error_handling', {}],
    ] as const) {
      const result = await c.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private fixture credential');
    }
  } finally {
    await c.close();
  }
});
test('malformed JSON and oversized bodies are rejected before dispatch', async () => {
  for (const [body, status] of [
    ['{', 400],
    [JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }), 413],
  ] as const) {
    expect(
      (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
        .status,
    ).toBe(status);
  }
});
test('stateless requests work across independent clients; legacy initialize is rejected', async () => {
  for (let i = 0; i < 2; i++) {
    const c = await client();
    try {
      expect((await c.listTools()).tools).toHaveLength(2);
    } finally {
      await c.close();
    }
  }
  const legacy = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'old', version: '1' },
      },
    }),
  });
  expect(legacy.status).toBeGreaterThanOrEqual(400);
});
test('client deadline cancels a slow MCP call', async () => {
  const c = await client();
  try {
    cancellationObserved = false;
    await expect(
      c.callTool({ name: 'fixture.wait', arguments: {} }, { timeout: 100 }),
    ).rejects.toThrow();
    await expect.poll(() => cancellationObserved).toBe(true);
  } finally {
    await c.close();
  }
});

for (const scenario of [
  'server-stateless',
  'tools-list',
  'tools-call-simple-text',
  'tools-call-error',
  'http-header-validation',
]) {
  test(`official conformance: ${scenario}`, async () => {
    const cli = resolve(
      dirname(
        createRequire(import.meta.url).resolve('@modelcontextprotocol/conformance/package.json'),
      ),
      'dist/index.js',
    );
    const directory = resolve('.local/conformance');
    await mkdir(directory, { recursive: true });
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolveResult, reject) => {
        const child = spawn(
          process.execPath,
          [cli, 'server', '--url', url, '--scenario', scenario, '--spec-version', '2026-07-28'],
          { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '';
        child.stdout.on('data', (b) => {
          output += String(b);
        });
        child.stderr.on('data', (b) => {
          output += String(b);
        });
        child.on('error', reject);
        child.on('close', (code) => resolveResult({ code, output }));
      },
    );
    await writeFile(resolve(directory, scenario + '.txt'), stripVTControlCharacters(result.output));
    expect(result.code, result.output).toBe(0);
  }, 60000);
}
