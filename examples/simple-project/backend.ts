import express from 'express';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
export interface ExampleOrder {
  id: string;
  customerId: string;
  productId: string;
  quantity: number;
  status: string;
}
export interface ExampleBackend {
  app: express.Express;
  orders: Map<string, ExampleOrder>;
  counts(): { created: number; cancelled: number };
}
export function exampleBackend(token: string): ExampleBackend {
  const customers = [{ id: 'customer-1', name: 'Example customer' }];
  const products = [
    { id: 'product-1', name: 'Notebook', price: 12 },
    { id: 'product-2', name: 'Keyboard', price: 75 },
  ];
  const orders = new Map<
    string,
    { id: string; customerId: string; productId: string; quantity: number; status: string }
  >();
  const receipts = new Map<string, { fingerprint: string; result: unknown }>();
  let created = 0,
    cancelled = 0;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    const value = Buffer.from(req.get('authorization') ?? '');
    const expected = Buffer.from('Bearer ' + token);
    if (value.length !== expected.length || !timingSafeEqual(value, expected)) {
      res.sendStatus(401);
      return;
    }
    next();
  });
  app.get('/customers/:id', (req, res) => {
    const customer = customers.find((c) => c.id === req.params.id);
    res.status(customer ? 200 : 404).json(customer ?? { error: 'Unknown customer' });
  });
  app.get('/products', (req, res) =>
    res.json(
      products.filter((p) =>
        p.name.toLowerCase().includes(String(req.query.query ?? '').toLowerCase()),
      ),
    ),
  );
  app.use((req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) {
      res.sendStatus(400);
      return;
    }
    const fingerprint = JSON.stringify({ method: req.method, path: req.path, body: req.body });
    const receipt = receipts.get(key);
    if (receipt) {
      res
        .status(receipt.fingerprint === fingerprint ? 200 : 409)
        .json(
          receipt.fingerprint === fingerprint ? receipt.result : { error: 'Idempotency conflict' },
        );
      return;
    }
    res.locals.receipt = (result: unknown) =>
      receipts.set(key, { fingerprint, result: structuredClone(result) });
    next();
  });
  app.post('/orders', (req, res) => {
    const args = z
      .object({
        customerId: z.literal('customer-1'),
        productId: z.enum(['product-1', 'product-2']),
        quantity: z.number().int().min(1).max(10),
      })
      .strict()
      .parse(req.body);
    const order = { ...args, id: randomUUID(), status: 'active' };
    orders.set(order.id, order);
    created++;
    res.locals.receipt(order);
    res.json(order);
  });
  app.delete('/orders/:id', (req, res) => {
    const order = orders.get(String(req.params.id));
    if (!order) {
      res.sendStatus(404);
      return;
    }
    if (order.status !== 'cancelled') {
      order.status = 'cancelled';
      cancelled++;
    }
    res.locals.receipt(order);
    res.json(order);
  });
  app.use(
    (_e: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(400).json({ error: 'Invalid request' });
    },
  );
  return { app, orders, counts: () => ({ created, cancelled }) };
}
