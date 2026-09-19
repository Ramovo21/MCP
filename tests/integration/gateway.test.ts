import { test, expect } from 'vitest';
import { fixture } from '../helpers/fixture.js';
test('real demo tools execute, validate input, enforce permissions, and record traces', async () => {
  const f = await fixture();
  try {
    const result = await f.execution.call(f.principal, 'demo.crm.customer.search', {});
    expect(result.status).toBe('succeeded');
    expect(result.result).toEqual([expect.objectContaining({ name: 'Ada Nguyen' })]);
    expect(
      (await f.execution.call(f.principal, 'demo.crm.customer.get', { id: 'bad' })).status,
    ).toBe('denied');
    expect(
      (
        await f.execution.call({ ...f.principal, role: 'viewer' }, 'demo.crm.note.create', {
          customerId: f.customer,
          body: 'secret',
        })
      ).status,
    ).toBe('denied');
    const pending = await f.execution.call(
      f.principal,
      'demo.crm.note.create',
      { customerId: f.customer, body: 'private' },
      'write-1',
    );
    expect(pending.status).toBe('pending');
    expect((await f.db.system.query('select * from demo_notes')).rows).toHaveLength(0);
    expect((await f.db.system.query('select * from executions')).rows).toHaveLength(4);
    expect((await f.db.system.query('select * from execution_steps')).rows.length).toBeGreaterThan(
      4,
    );
  } finally {
    await f.db.close();
  }
});
