import { test, expect } from 'vitest';
import { operations } from '../../connectors/openapi/src/index.js';
import { buildSearch, quote } from '../../connectors/postgres/src/index.js';
import { resolveSafeHost, isPublicAddress } from '../../packages/shared/src/http.js';
import { verifySignature, signature } from '../../connectors/webhook/src/index.js';
const spec = {
  openapi: '3.1.0',
  paths: {
    '/customers/{id}': {
      get: {
        operationId: 'customer.get',
        summary: 'Get a customer',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/ID' } },
        ],
      },
      delete: {
        operationId: 'customer.delete',
        parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }],
      },
    },
  },
  components: { schemas: { ID: { type: 'string', format: 'uuid' } } },
};
test('OpenAPI resolves local schemas, preserves required parameters and classifies destructive operations', () => {
  const t = operations(spec, 'company');
  expect(t).toHaveLength(2);
  expect(t[0]?.inputSchema).toMatchObject({
    required: ['id'],
    properties: { id: { format: 'uuid' } },
  });
  expect(t[1]?.risk).toBe('CRITICAL');
});
test('OpenAPI rejects external/cyclic refs and unsafe credential headers', () => {
  expect(() =>
    operations({ ...spec, paths: { '/x': { $ref: 'https://localhost/spec' } } }, 'company'),
  ).toThrow(/External/);
  expect(() =>
    operations({ openapi: '3.0.0', paths: { '/x': { $ref: '#/paths/~1x' } } }, 'company'),
  ).toThrow(/cyclic/);
  expect(() =>
    operations(
      {
        openapi: '3.0.0',
        paths: { '/x': { get: { parameters: [{ in: 'header', name: 'Authorization' }] } } },
      },
      'company',
    ),
  ).toThrow(/headers/);
});
test('SQL values are parameterized and identifiers/projections allowlisted', () => {
  const sql = buildSearch(
    { schema: 'public', table: 'customers', columns: ['name', 'id'] },
    { filters: { name: "';drop table customers;--" } },
  );
  expect(sql.text).toBe('select "name","id" from "public"."customers" where "name"=$1 limit $2');
  expect(sql.values[0]).toContain('drop table');
  expect(() => quote('name";drop table x')).toThrow();
  expect(() =>
    buildSearch(
      { schema: 'public', table: 'customers', columns: ['id'] },
      { filters: { password: 'x' } },
    ),
  ).toThrow(/not selected/);
});
test('SSRF blocks IPv4, IPv6, mapped IPs, metadata, and mixed public/private DNS answers', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.2',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '100.64.0.1',
  ])
    expect(isPublicAddress(address)).toBe(false);
  await expect(
    resolveSafeHost('service.example', { privateHosts: [] }, async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
  ).rejects.toThrow(/forbidden/);
  await expect(
    resolveSafeHost('169.254.169.254', { privateHosts: ['169.254.169.254'] }),
  ).rejects.toThrow(/forbidden/);
});
test('webhook HMAC rejects tampering, missing signatures and expired messages', () => {
  const secret = 'x'.repeat(32),
    timestamp = String(Math.floor(Date.now() / 1000)),
    body = Buffer.from('{"event":"created"}'),
    sig = 'sha256=' + signature(secret, timestamp, body);
  expect(() => verifySignature(secret, timestamp, sig, body)).not.toThrow();
  expect(() => verifySignature(secret, timestamp, sig, Buffer.from('tampered'))).toThrow();
  expect(() => verifySignature(secret, timestamp, undefined, body)).toThrow();
  expect(() => verifySignature(secret, '1000000000', sig, body)).toThrow();
});
