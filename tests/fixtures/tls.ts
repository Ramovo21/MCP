import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Ephemeral localhost-only test identity. No private keys are checked into the repository. */
export async function fixtureTls() {
  const directory = await mkdtemp(join(tmpdir(), 'omnimcp-audit-tls-'));
  const key = join(directory, 'key.pem'),
    cert = join(directory, 'cert.pem');
  const gitOpenSsl = join(
    process.env.ProgramFiles ?? 'C:/Program Files',
    'Git/usr/bin/openssl.exe',
  );
  const binary =
    process.env.AUDIT_OPENSSL ??
    (process.platform === 'win32' && existsSync(gitOpenSsl) ? gitOpenSsl : 'openssl');
  try {
    await promisify(execFile)(
      binary,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { windowsHide: true, timeout: 15000 },
    );
  } catch {
    throw new Error(
      'Audit HTTPS fixtures require OpenSSL (Git for Windows includes it); set AUDIT_OPENSSL if needed.',
    );
  }
  return {
    key,
    cert,
    async close() {
      await unlink(key);
      await unlink(cert);
      await rmdir(directory);
    },
  };
}
