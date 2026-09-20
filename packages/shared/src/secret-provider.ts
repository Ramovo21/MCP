import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AesGcmVault } from './secrets.js';

/** Cloud adapters implement this boundary; errors must never contain secret values. */
export interface SecretProvider {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}
function validateKey(key: string) {
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(key)) throw new Error('Invalid secret key');
}
export class EnvironmentSecretProvider implements SecretProvider {
  constructor(private values: Record<string, string | undefined> = process.env) {}
  async getSecret(key: string) {
    validateKey(key);
    return this.values[key] ?? null;
  }
  async setSecret(key: string, value: string) {
    validateKey(key);
    this.values[key] = value;
  }
  async deleteSecret(key: string) {
    validateKey(key);
    delete this.values[key];
  }
}
/** Single-host development provider; atomic replacement, authenticated per-key encryption. */
export class LocalEncryptedSecretProvider implements SecretProvider {
  private vault: AesGcmVault;
  constructor(
    private directory: string,
    encryptionKey: string,
  ) {
    this.vault = new AesGcmVault(encryptionKey);
  }
  async getSecret(key: string) {
    validateKey(key);
    try {
      return this.vault.open<string>(
        await readFile(join(this.directory, key), 'utf8'),
        'secret-provider:' + key,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Secret could not be decrypted');
    }
  }
  async setSecret(key: string, value: string) {
    validateKey(key);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, '.' + randomUUID());
    try {
      await writeFile(temporary, this.vault.seal(value, 'secret-provider:' + key), {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, join(this.directory, key));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  async deleteSecret(key: string) {
    validateKey(key);
    await unlink(join(this.directory, key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw new Error('Secret could not be deleted');
    });
  }
}
export async function hydrateSecrets(
  provider?: SecretProvider,
  keys = [
    'MASTER_KEY',
    'DATABASE_URL',
    'WORKER_AUTH_TOKEN',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'SUPABASE_ANON_KEY',
  ],
) {
  if (!provider && process.env.SECRET_PROVIDER_MODULE) {
    provider = ((await import(process.env.SECRET_PROVIDER_MODULE)) as { default: SecretProvider })
      .default;
  }
  if (!provider) return;
  for (const key of keys) {
    const value = await provider.getSecret(key);
    if (value !== null) process.env[key] = value;
  }
}
