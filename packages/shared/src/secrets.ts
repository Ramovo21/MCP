import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import type { JsonObject } from './index.js';
export interface SecretVault {
  seal(value: unknown, context: string): string;
  open<T>(value: string, context: string): T;
}
export class AesGcmVault implements SecretVault {
  private key: Buffer;
  constructor(masterKey: string) {
    this.key = Buffer.from(masterKey, 'base64');
    if (this.key.length !== 32) throw new Error('MASTER_KEY must encode 32 random bytes');
  }
  seal(value: unknown, context: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [
      'v1',
      nonce.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ].join('.');
  }
  open<T>(value: string, context: string): T {
    const [version, n, t, b] = value.split('.');
    if (version !== 'v1' || !n || !t || !b) throw new Error('Invalid ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(n, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(t, 'base64'));
    return JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(b, 'base64')), decipher.final()]).toString(),
    ) as T;
  }
}
const sensitive =
  /password|secret|token|authorization|cookie|credential|api[_-]?key|email|phone|body|note|content/i;
export function redact(value: unknown, schema?: JsonObject): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        sensitive.test(key) ||
        (schema?.properties as Record<string, JsonObject> | undefined)?.[key]?.writeOnly === true
          ? '[REDACTED]'
          : redact(v, (schema?.properties as Record<string, JsonObject> | undefined)?.[key]),
      ]),
    );
  return value;
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Strip stored credential values even if an upstream echoes them under an unexpected field. */
export function scrubSecrets(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    let safe = value;
    for (const secret of secrets.filter(Boolean)) safe = safe.split(secret).join('[REDACTED]');
    return safe;
  }
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        String(scrubSecrets(k, secrets)),
        scrubSecrets(v, secrets),
      ]),
    );
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
