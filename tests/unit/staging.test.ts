import { test, expect } from 'vitest';
import { mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gatewayConfig, workerConfig } from '../../packages/shared/src/config.js';
import {
  EnvironmentSecretProvider,
  LocalEncryptedSecretProvider,
} from '../../packages/shared/src/secret-provider.js';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  initializeTelemetry,
  shutdownTelemetry,
  flushTelemetry,
  withSpan,
} from '../../packages/shared/src/telemetry.js';
import { traceEvent } from '../../packages/shared/src/tracing.js';

test('startup validation identifies missing keys without disclosing values and enforces staging HTTPS', () => {
  expect(() => workerConfig({ DATABASE_URL: 'credential-do-not-print' })).toThrow(
    'WORKER_AUTH_TOKEN',
  );
  try {
    gatewayConfig({ DATABASE_URL: 'credential-do-not-print' });
  } catch (error) {
    expect(String(error)).not.toContain('credential-do-not-print');
  }
  const base = {
    APP_ENV: 'staging',
    DATABASE_URL: 'postgres://db',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_ANON_KEY: 'public',
    MASTER_KEY: randomBytes(32).toString('base64'),
    WEB_ORIGIN: 'https://web.example',
    OAUTH_REDIRECT_BASE: 'https://api.example',
    GATEWAY_HOSTS: 'api.example',
    WORKER_URL: 'http://worker:4100',
    WORKER_AUTH_TOKEN: randomBytes(32).toString('hex'),
  };
  expect(gatewayConfig(base).APP_ENV).toBe('staging');
  expect(() => gatewayConfig({ ...base, WEB_ORIGIN: 'http://web.example' })).toThrow('HTTPS');
  expect(() => gatewayConfig({ ...base, WORKER_URL: undefined })).toThrow('WORKER_URL');
});
test('secret providers roundtrip, delete and reject ciphertext swapping and path traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimcp-secrets-'));
  try {
    for (const provider of [
      new EnvironmentSecretProvider({}),
      new LocalEncryptedSecretProvider(dir, randomBytes(32).toString('base64')),
    ]) {
      expect(await provider.getSecret('EXAMPLE')).toBeNull();
      await provider.setSecret('EXAMPLE', 'secret-only-in-test');
      expect(await provider.getSecret('EXAMPLE')).toBe('secret-only-in-test');
      if (provider instanceof LocalEncryptedSecretProvider) {
        expect(await readFile(join(dir, 'EXAMPLE'), 'utf8')).not.toContain('secret-only-in-test');
        await copyFile(join(dir, 'EXAMPLE'), join(dir, 'OTHER'));
        await expect(provider.getSecret('OTHER')).rejects.toThrow('decrypted');
      }
      await expect(provider.setSecret('../ESCAPE', 'value')).rejects.toThrow('key');
      await provider.deleteSecret('EXAMPLE');
      expect(await provider.getSecret('EXAMPLE')).toBeNull();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('real OTel spans preserve parentage, duration and sanitized error metadata', async () => {
  await shutdownTelemetry();
  const exporter = new InMemorySpanExporter();
  initializeTelemetry('test', exporter);
  await withSpan(
    'gateway.request',
    { organizationId: 'tenant-one', token: 'forbidden-secret' },
    async () => {
      await withSpan(
        'connector.execute',
        { connector: 'google-workspace', arguments: { query: 'private-query' } },
        async () => {
          traceEvent('upstream_response', { status: 200, authorization: 'forbidden-secret' });
          await new Promise((r) => setTimeout(r, 10));
        },
      );
      await expect(
        withSpan('upstream.http', {}, async () => {
          throw new Error('forbidden-secret');
        }),
      ).rejects.toThrow();
    },
  );
  await flushTelemetry();
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(3);
  const root = spans.find((s) => s.name === 'gateway.request')!,
    child = spans.find((s) => s.name === 'connector.execute')!;
  expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
  expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  expect(child.duration[0] * 1e9 + child.duration[1]).toBeGreaterThan(0);
  expect(
    JSON.stringify(spans.map((s) => ({ attributes: s.attributes, events: s.events }))),
  ).not.toMatch(/forbidden-secret|private-query/);
  expect(spans.find((s) => s.name === 'upstream.http')!.status.code).toBe(2);
  await shutdownTelemetry();
});
