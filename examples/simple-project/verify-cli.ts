import { readFile } from 'node:fs/promises';
import { verifyExample, type ExampleSession } from './verify.js';
const session = JSON.parse(
  await readFile('.local/simple-project/session.json', 'utf8'),
) as ExampleSession;
process.stdout.write(JSON.stringify(await verifyExample(session), null, 2) + '\n');
