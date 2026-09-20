import { defineConnector } from '../../packages/connector-sdk/src/index.js';
export default defineConnector({
  id: 'audit-failure',
  name: 'Audit failure fixture',
  version: '1',
  tools: [
    {
      namespace: 'audit.fixture',
      name: 'writeCrash',
      description: 'Test-only write followed by process crash',
      risk: 'WRITE',
      inputSchema: {
        type: 'object',
        properties: { customerId: { type: 'string', format: 'uuid' } },
        required: ['customerId'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        await ctx.database.tenant(ctx.organizationId, (sql) =>
          sql.query(
            'insert into demo_notes(organization_id,customer_id,body,execution_id) values($1,$2,$3,$4)',
            [ctx.organizationId, args.customerId, 'Audit ambiguous effect', ctx.executionId],
          ),
        );
        process.exit(74);
      },
    },
    {
      namespace: 'audit.fixture',
      name: 'crash',
      description: 'Test-only process exit',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'READ',
      execute: async () => {
        process.exit(73);
      },
    },
    {
      namespace: 'audit.fixture',
      name: 'timeout',
      description: 'Test-only infinite loop',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'READ',
      execute: async () => {
        for (;;) {
          /* deliberate uncooperative connector */
        }
      },
    },
    {
      namespace: 'audit.fixture',
      name: 'oversized',
      description: 'Test-only oversized result',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'READ',
      execute: async () => 'x'.repeat(3 * 1024 * 1024),
    },
  ],
});
