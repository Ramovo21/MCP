import { config } from 'dotenv';
import { fileURLToPath, URL } from 'node:url';
config({ path: '../../.env', quiet: true });
export default {
  poweredByHeader: false,
  output: process.env.NEXT_STANDALONE === '1' ? 'standalone' : undefined,
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
