import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
export interface ExampleSession {
  url: string;
  organizationId: string;
  userToken: string;
  approverToken: string;
}
export async function verifyExample(session: ExampleSession) {
  const headers = {
    authorization: `Bearer ${session.userToken}`,
    'x-organization-id': session.organizationId,
    'content-type': 'application/json',
  };
  const client = new Client(
    { name: 'simple-project-client', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const request = async (path: string, body?: unknown, token = session.userToken) => {
    const response = await fetch(session.url + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(session.url + '/mcp'), {
        requestInit: { headers },
      }),
    );
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), [
      'customer.get',
      'order.cancel',
      'order.create',
      'product.search',
    ]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, false);
      return result.structuredContent as {
        status: string;
        executionId: string;
        traceId: string;
        result: { id: string };
      };
    };
    assert.equal((await call('customer.get', { id: 'customer-1' })).result.id, 'customer-1');
    assert.equal((await call('product.search', { query: 'Note' })).status, 'succeeded');
    const order = await call('order.create', {
      customerId: 'customer-1',
      productId: 'product-1',
      quantity: 2,
    });
    assert.equal(order.status, 'succeeded');
    const pending = await call('order.cancel', { id: order.result.id });
    assert.equal(pending.status, 'pending');
    const overview = (await (await request('/api/console')).json()) as {
      approvals: { id: string; execution_id: string }[];
    };
    const approval = overview.approvals.find((a) => a.execution_id === pending.executionId);
    assert.ok(approval);
    assert.equal(
      (await request(`/api/approvals/${approval.id}/decide`, { decision: 'approved' })).status,
      403,
      'Self approval must fail',
    );
    const accept = await request(
      `/api/approvals/${approval.id}/decide`,
      { decision: 'approved' },
      session.approverToken,
    );
    assert.equal(accept.status, 200);
    assert.equal(((await accept.json()) as { status: string }).status, 'succeeded');
    assert.equal(
      (
        await request(
          `/api/approvals/${approval.id}/decide`,
          { decision: 'approved' },
          session.approverToken,
        )
      ).status,
      409,
    );
    const detail = (await (
      await request('/api/executions/' + pending.executionId)
    ).json()) as Record<string, unknown>;
    assert.ok(
      JSON.stringify(detail).includes('connector_started'),
      'Real child worker trace required',
    );
    return {
      listed: listed.tools.length,
      readCalls: 2,
      writeCalls: 1,
      criticalApproved: 1,
      selfApprovalRejected: true,
      duplicateApprovalRejected: true,
      traceId: pending.traceId,
    };
  } finally {
    await client.close();
  }
}
