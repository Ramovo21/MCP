import { defineConnector } from '../../../packages/connector-sdk/src/index.js';
import { AppError } from '../../../packages/shared/src/index.js';
export const demoCrm = defineConnector({
  id: 'demo-crm',
  name: 'Demo CRM',
  version: '1.0.0',
  tools: [
    {
      namespace: 'demo.crm.customer',
      name: 'search',
      description:
        'Search organization demo CRM customers by name or company. Returns at most 25 customers.',
      risk: 'READ',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', maxLength: 100 } },
        additionalProperties: false,
      },
      async execute(args, ctx) {
        return ctx.database.tenant(
          ctx.organizationId,
          async (sql) =>
            (
              await sql.query(
                'select id,name,email,company from demo_customers where organization_id=$1 and (name ilike $2 or company ilike $2) order by name limit 25',
                [ctx.organizationId, `%${String(args.query ?? '')}%`],
              )
            ).rows,
        );
      },
    },
    {
      namespace: 'demo.crm.customer',
      name: 'get',
      description: 'Retrieve one demo CRM customer using its UUID from customer.search.',
      risk: 'READ',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } },
        required: ['id'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        const r = await ctx.database.tenant(ctx.organizationId, (sql) =>
          sql.query(
            'select id,name,email,company from demo_customers where organization_id=$1 and id=$2',
            [ctx.organizationId, args.id],
          ),
        );
        if (!r.rows[0]) throw new AppError('NOT_FOUND', 'Customer not found', 404);
        return r.rows[0];
      },
    },
    {
      namespace: 'demo.crm.note',
      name: 'create',
      description:
        'Add a note to a demo CRM customer. This writes data and follows organization approval policy.',
      risk: 'WRITE',
      inputSchema: {
        type: 'object',
        properties: {
          customerId: { type: 'string', format: 'uuid' },
          body: { type: 'string', minLength: 1, maxLength: 2000, writeOnly: true },
        },
        required: ['customerId', 'body'],
        additionalProperties: false,
      },
      async execute(args, ctx) {
        return ctx.database.tenant(ctx.organizationId, async (sql) => {
          const r = await sql.query(
            'insert into demo_notes(organization_id,customer_id,body,execution_id) values($1,$2,$3,$4) on conflict(organization_id,execution_id) do update set body=demo_notes.body returning id,customer_id,created_at',
            [ctx.organizationId, args.customerId, args.body, ctx.executionId],
          );
          return r.rows[0];
        });
      },
    },
  ],
});
