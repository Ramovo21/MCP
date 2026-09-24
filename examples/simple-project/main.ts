import 'dotenv/config';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { startExample } from './runtime.js';
if (!process.env.DATABASE_URL) throw Error('Run pnpm db:start and pnpm env:local first');
const example = await startExample(
  process.env.DATABASE_URL,
  Number(process.env.EXAMPLE_PORT ?? 4200),
);
await mkdir('.local/simple-project', { recursive: true });
const session = '.local/simple-project/session.json';
await writeFile(
  session,
  JSON.stringify({
    url: example.url,
    organizationId: example.org,
    userToken: example.userToken,
    approverToken: example.approverToken,
  }),
  { mode: 0o600 },
);
process.stdout.write(
  `Example MCP: ${example.url}/mcp\nLocal credentials: ${session} (ignored; removed on shutdown)\nRun pnpm example:verify in another terminal.\n`,
);
for (const event of ['SIGINT', 'SIGTERM'])
  process.once(event, () => {
    void example.close().finally(async () => {
      await unlink(session).catch(() => undefined);
      process.exit(0);
    });
  });
