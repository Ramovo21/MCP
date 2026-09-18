import { randomBytes } from 'node:crypto';
import type { Express, Request } from 'express';
import { z } from 'zod';
import { audit } from '../../../packages/database/src/index.js';
import {
  AppError,
  assertAdmin,
  risks,
  uuid,
  type Principal,
  type ToolRecord,
  type Connection,
} from '../../../packages/shared/src/index.js';
import { hash } from '../../../packages/shared/src/secrets.js';
import { verifySignature } from '../../../connectors/webhook/src/index.js';
import { ApprovalService } from './approvals.js';
import { connectionInput, type ConnectionService } from './connections.js';
import type { ExecutionService } from './execution.js';
export function mountInbound(app: Express, connections: ConnectionService) {
  app.post('/webhooks/:id', async (req, res) => {
    const id = uuid.parse(req.params.id),
      row = (
        await connections.db.system.query<Connection>(
          "select * from connections where id=$1 and connector_id='webhook' and status='active'",
          [id],
        )
      ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'Webhook not found', 404);
    const ctx = await connections.context(
      { organizationId: row.organization_id, role: 'viewer' },
      id,
    );
    if (row.config.inbound === false || !ctx.secrets.signingSecret)
      throw new AppError('FORBIDDEN', 'Inbound webhook is disabled', 403);
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw) throw new AppError('INVALID_BODY', 'JSON webhook body required');
    const timestamp = req.get('x-omni-timestamp');
    verifySignature(ctx.secrets.signingSecret, timestamp, req.get('x-omni-signature'), raw);
    const digest = hash(timestamp + '.' + raw.toString('utf8'));
    await connections.db.tenant(row.organization_id, async (sql) => {
      const r = await sql.query(
        'insert into webhook_events(organization_id,connection_id,event_hash,payload_encrypted) values($1,$2,$3,$4) on conflict do nothing returning id',
        [
          row.organization_id,
          id,
          digest,
          connections.vault.seal(req.body, `${row.organization_id}:webhook:${id}:${digest}`),
        ],
      );
      if (!r.rows[0]) throw new AppError('REPLAY_DETECTED', 'Webhook event already received', 409);
      await audit(
        sql,
        { organizationId: row.organization_id, role: 'viewer' },
        'webhook.received',
        id,
        { bytes: raw.length },
      );
    });
    res.status(202).json({ accepted: true });
  });
}
export function mountManagement(
  app: Express,
  execution: ExecutionService,
  connections: ConnectionService,
) {
  const approvals = new ApprovalService(execution),
    db = execution.db;
  app.get('/api/console', async (_req, res) => {
    const p = res.locals.principal as Principal;
    const data = await db.tenant(p.organizationId, async (sql) => {
      const query = (text: string) => sql.query(text, [p.organizationId]).then((r) => r.rows);
      const admin = !p.apiKeyId && ['owner', 'admin'].includes(p.role);
      return {
        organization: (await query('select * from organizations where id=$1'))[0],
        role: p.role,
        connectors: connections.registry.list(),
        connections: await query(
          'select id,name,connector_id,status,created_at from connections where organization_id=$1 order by created_at desc',
        ),
        tools: admin
          ? await query(
              'select t.*, (select count(*) from executions e where e.organization_id=t.organization_id and e.tool_id=t.id) usage_count from tools t where t.organization_id=$1 order by name',
            )
          : [],
        metrics: (
          await query(
            "select count(*)::int calls,count(*) filter(where status='succeeded')::int succeeded,count(*) filter(where status in ('failed','denied','unknown'))::int failed,coalesce(round(avg(duration_ms)),0)::int latency from executions where organization_id=$1",
          )
        )[0],
        executions: await query(
          'select id,tool_name,connector_id,status,arguments_redacted,started_at,duration_ms,result_metadata,error_metadata from executions where organization_id=$1 order by started_at desc limit 100',
        ),
        approvals: admin
          ? await query(
              'select a.*,e.tool_name,e.arguments_redacted,e.principal,e.tool_id,t.connection_id,c.name connection_name from approval_requests a join executions e on e.organization_id=a.organization_id and e.id=a.execution_id left join tools t on t.organization_id=e.organization_id and t.id=e.tool_id left join connections c on c.organization_id=t.organization_id and c.id=t.connection_id where a.organization_id=$1 order by a.created_at desc limit 100',
            )
          : [],
        audit: admin
          ? await query(
              'select * from audit_logs where organization_id=$1 order by created_at desc limit 100',
            )
          : [],
        keys: admin
          ? await query(
              'select id,name,prefix,scopes,role,created_at,last_used_at,revoked_at from api_keys where organization_id=$1 order by created_at desc',
            )
          : [],
        members: admin
          ? await query('select user_id,role from organization_members where organization_id=$1')
          : [],
        servers: await query('select * from mcp_servers where organization_id=$1'),
        policy: await execution.policy(sql, p.organizationId),
      };
    });
    if (!data.tools.length) data.tools = await execution.list(p);
    res.json(data);
  });
  app.get('/api/executions/:id', async (req, res) => {
    const p = res.locals.principal as Principal,
      id = uuid.parse(req.params.id);
    res.json(
      await db.tenant(p.organizationId, async (sql) => {
        const row = (
          await sql.query(
            'select id,request_id,tool_name,connector_id,user_id,api_key_id,status,arguments_redacted,started_at,finished_at,duration_ms,result_metadata,error_metadata from executions where organization_id=$1 and id=$2',
            [p.organizationId, id],
          )
        ).rows[0];
        if (!row) throw new AppError('NOT_FOUND', 'Execution not found', 404);
        return {
          ...row,
          steps: (
            await sql.query(
              'select stage,metadata,created_at from execution_steps where organization_id=$1 and execution_id=$2 order by id',
              [p.organizationId, id],
            )
          ).rows,
        };
      }),
    );
  });
  app.post('/api/connections', async (req, res) =>
    res
      .status(201)
      .json(await connections.create(res.locals.principal, connectionInput.parse(req.body))),
  );
  app.post('/api/connections/:id/discover', async (req, res) =>
    res.json(await connections.discover(res.locals.principal, uuid.parse(req.params.id))),
  );
  app.post('/api/connections/:id/import', async (req, res) => {
    const input = z
      .object({ names: z.array(z.string()).max(500) })
      .strict()
      .parse(req.body);
    res.json(
      await connections.import(res.locals.principal, uuid.parse(req.params.id), input.names),
    );
  });
  app.post('/api/connections/:id/test', async (req, res) =>
    res.json(await connections.test(res.locals.principal, uuid.parse(req.params.id))),
  );
  app.get('/api/connections/:id/schema', async (req, res) =>
    res.json(await connections.schema(res.locals.principal, uuid.parse(req.params.id))),
  );
  app.patch('/api/connections/:id', async (req, res) => {
    const input = z
      .object({ status: z.enum(['active', 'disabled', 'revoked']) })
      .strict()
      .parse(req.body);
    await connections.update(res.locals.principal, uuid.parse(req.params.id), input.status);
    res.json({ ok: true });
  });
  app.put('/api/connections/:id/config', async (req, res) => {
    const input = z.record(z.string(), z.unknown()).parse(req.body);
    await connections.configure(res.locals.principal, uuid.parse(req.params.id), input);
    res.json({ ok: true });
  });
  app.patch('/api/tools/:id', async (req, res) => {
    const p = res.locals.principal as Principal;
    assertAdmin(p);
    const id = uuid.parse(req.params.id),
      input = z
        .object({ enabled: z.boolean().optional(), risk: z.enum(risks).optional() })
        .strict()
        .parse(req.body);
    await db.tenant(p.organizationId, async (sql) => {
      const t = (
        await sql.query<ToolRecord>(
          'select * from tools where organization_id=$1 and id=$2 for update',
          [p.organizationId, id],
        )
      ).rows[0];
      if (!t) throw new AppError('NOT_FOUND', 'Tool not found', 404);
      if (input.risk && risks.indexOf(input.risk) < risks.indexOf(t.baseline_risk))
        throw new AppError('RISK_DOWNGRADE', 'Cannot lower risk below connector baseline');
      await sql.query('update tools set enabled=$3,risk=$4 where organization_id=$1 and id=$2', [
        p.organizationId,
        id,
        input.enabled ?? t.enabled,
        input.risk ?? t.risk,
      ]);
      await audit(sql, p, 'tool.updated', id, input);
    });
    res.json({ ok: true });
  });
  app.put('/api/tools/:id/permissions', async (req, res) => {
    const p = res.locals.principal as Principal;
    assertAdmin(p);
    const input = z
      .object({ role: z.enum(['owner', 'admin', 'developer', 'viewer']), allowed: z.boolean() })
      .strict()
      .parse(req.body);
    await db.tenant(p.organizationId, async (sql) => {
      await sql.query(
        'insert into tool_permissions(organization_id,tool_id,role,allowed) values($1,$2,$3,$4) on conflict(organization_id,tool_id,role) do update set allowed=excluded.allowed',
        [p.organizationId, uuid.parse(req.params.id), input.role, input.allowed],
      );
      await audit(sql, p, 'tool.permission_changed', String(req.params.id), input);
    });
    res.json({ ok: true });
  });
  app.post('/api/approvals/:id/decide', async (req, res) => {
    const input = z
      .object({ decision: z.enum(['approved', 'rejected']) })
      .strict()
      .parse(req.body);
    res.json(
      await approvals.decide(res.locals.principal, uuid.parse(req.params.id), input.decision),
    );
  });
  app.put('/api/policy', async (req, res) => {
    const p = res.locals.principal as Principal;
    assertAdmin(p);
    const input = z
      .object({
        allow_write: z.boolean(),
        sensitive_approval: z.boolean(),
        allow_self_approval: z.boolean(),
      })
      .strict()
      .parse(req.body);
    await db.tenant(p.organizationId, async (sql) => {
      await sql.query(
        'insert into approval_policies(organization_id,allow_write,sensitive_approval,allow_self_approval) values($1,$2,$3,$4) on conflict(organization_id) do update set allow_write=excluded.allow_write,sensitive_approval=excluded.sensitive_approval,allow_self_approval=excluded.allow_self_approval,updated_at=now()',
        [p.organizationId, input.allow_write, input.sensitive_approval, input.allow_self_approval],
      );
      await audit(sql, p, 'policy.updated', p.organizationId, input);
    });
    res.json({ ok: true });
  });
  app.post('/api/keys', async (req, res) => {
    const p = res.locals.principal as Principal;
    assertAdmin(p);
    const input = z
        .object({
          name: z.string().min(1).max(100),
          scopes: z.array(z.string()).min(1).max(500),
          role: z.enum(['developer', 'viewer']).default('developer'),
        })
        .strict()
        .parse(req.body),
      key = 'omni_' + randomBytes(32).toString('base64url');
    const row = await db.tenant(p.organizationId, async (sql) => {
      const tools = await sql.query<{ name: string }>(
        'select name from tools where organization_id=$1',
        [p.organizationId],
      );
      if (input.scopes.some((s) => !tools.rows.some((t) => t.name === s)))
        throw new AppError('INVALID_SCOPE', 'Key scopes must reference organization tools');
      const r = await sql.query(
        'insert into api_keys(organization_id,name,prefix,key_hash,scopes,role,created_by) values($1,$2,$3,$4,$5,$6,$7) returning id,name,prefix',
        [
          p.organizationId,
          input.name,
          key.slice(0, 12),
          hash(key),
          input.scopes,
          input.role,
          p.userId,
        ],
      );
      await audit(sql, p, 'api_key.created', String(r.rows[0]!.id));
      return r.rows[0];
    });
    res
      .set('Cache-Control', 'no-store')
      .status(201)
      .json({ ...row, key });
  });
  app.delete('/api/keys/:id', async (req, res) => {
    const p = res.locals.principal as Principal;
    assertAdmin(p);
    await db.tenant(p.organizationId, async (sql) => {
      await sql.query('update api_keys set revoked_at=now() where organization_id=$1 and id=$2', [
        p.organizationId,
        uuid.parse(req.params.id),
      ]);
      await audit(sql, p, 'api_key.revoked', String(req.params.id));
    });
    res.json({ ok: true });
  });
  app.post('/api/members', async (req, res) => {
    const p = res.locals.principal as Principal;
    assertAdmin(p);
    if (p.role !== 'owner') throw new AppError('FORBIDDEN', 'Only owners manage membership', 403);
    const input = z
      .object({ userId: uuid, role: z.enum(['admin', 'developer', 'viewer']) })
      .strict()
      .parse(req.body);
    if (input.userId === p.userId)
      throw new AppError('FORBIDDEN', 'Cannot change your own ownership', 403);
    await db.tenant(p.organizationId, async (sql) => {
      await sql.query(
        'insert into organization_members(organization_id,user_id,role) values($1,$2,$3) on conflict(organization_id,user_id) do update set role=excluded.role',
        [p.organizationId, input.userId, input.role],
      );
      await audit(sql, p, 'member.updated', input.userId, { role: input.role });
    });
    res.json({ ok: true });
  });
  app.delete('/api/members/:id', async (req, res) => {
    const p = res.locals.principal as Principal;
    assertAdmin(p);
    if (p.role !== 'owner' || req.params.id === p.userId)
      throw new AppError('FORBIDDEN', 'Only an owner can remove another member', 403);
    await db.tenant(p.organizationId, async (sql) => {
      await sql.query(
        "delete from organization_members where organization_id=$1 and user_id=$2 and role<>'owner'",
        [p.organizationId, uuid.parse(req.params.id)],
      );
      await audit(sql, p, 'member.removed', String(req.params.id));
    });
    res.json({ ok: true });
  });
}
