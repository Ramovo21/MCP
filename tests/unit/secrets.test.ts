import { expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { AesGcmVault, redact } from '../../packages/shared/src/secrets.js';
test('authenticated encryption binds ciphertext to tenant and record', () => {
  const vault = new AesGcmVault(randomBytes(32).toString('base64'));
  const sealed = vault.seal({ password: 'private' }, 'org:connection');
  expect(sealed).not.toContain('private');
  expect(vault.open(sealed, 'org:connection')).toEqual({ password: 'private' });
  expect(() => vault.open(sealed, 'other:connection')).toThrow();
  expect(redact({ password: 'private', nested: { authorization: 'bearer' } })).toEqual({
    password: '[REDACTED]',
    nested: { authorization: '[REDACTED]' },
  });
});
