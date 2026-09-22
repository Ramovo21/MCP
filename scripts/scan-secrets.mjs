import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const git = (...args) =>
  execFileSync('git', ['-c', `safe.directory=${process.cwd().replaceAll('\\', '/')}`, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
const forbidden = (path) =>
  /(^|\/)(node_modules|\.next)(\/|$)/.test(path) ||
  (/(^|\/)\.env($|\.)/.test(path) && !path.endsWith('.env.example'));
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /GOCSPX-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /sb_secret_[A-Za-z0-9_-]{20,}/,
  /AKIA[A-Z0-9]{16}/,
];
const known = [
  'MASTER_KEY',
  'WORKER_AUTH_TOKEN',
  'GOOGLE_CLIENT_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SEED_PASSWORD',
]
  .map((k) => process.env[k])
  .filter((v) => v && v.length >= 20);
const findings = [];
const inspect = (label, buffer) => {
  const text = buffer.toString('utf8');
  if (patterns.some((p) => p.test(text)) || known.some((s) => text.includes(s)))
    findings.push(label);
};
const files = git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
  .toString()
  .split('\0')
  .filter(Boolean);
for (const path of files) {
  if (forbidden(path)) findings.push('forbidden-file:' + path);
  try {
    inspect('working-tree:' + path, readFileSync(path));
  } catch {
    /* staged deletion */
  }
}
const objects = git('rev-list', '--objects', '--all').toString().trim().split('\n');
let blobs = 0;
for (const line of objects) {
  const [oid, ...parts] = line.split(' '),
    path = parts.join(' ');
  if (path && forbidden(path)) findings.push('history-forbidden-file:' + path);
  if (git('cat-file', '-t', oid).toString().trim() !== 'blob') continue;
  inspect('history-blob:' + oid, git('cat-file', 'blob', oid));
  blobs++;
}
// Report locations only; never echo matched values.
process.stdout.write(
  JSON.stringify({ files: files.length, historyBlobs: blobs, findings }, null, 2) + '\n',
);
if (findings.length) process.exitCode = 1;
