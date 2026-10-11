import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { httpServer, io } from '../../server.js';
import { app, loginSeedMerchant, registerMerchant, SEED_MERCHANT } from './helpers.js';

/**
 * Table Order Routes Tests
 * Covers Bug F (duplicate pending orders) plus item validation and the
 * Socket.IO events advertised in the README.
 */

const pizza = [{ name: 'Pizza', price: 12.5, quantity: 2 }];
let token;
let tableCounter = 100;
const nextTable = () => ++tableCounter;

function createOrder(body) {
  return request(app).post('/api/table-orders').send({ merchant_id: SEED_MERCHANT.id, items: pizza, ...body });
}

function updateStatus(orderId, status, authToken = token) {
  return request(app)
    .patch(`/api/table-orders/${orderId}/status`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ status });
}

before(async () => {
  token = await loginSeedMerchant();
});

describe('Bug F: duplicate table orders', () => {
  test('creates the first order for a table', async () => {
    const res = await createOrder({ table_number: nextTable() });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.status, 'pending');
    assert.strictEqual(res.body.data.total, 25);
  });

  test('rejects a second pending order for the same table with 409', async () => {
    const table = nextTable();
    const first = await createOrder({ table_number: table });
    const second = await createOrder({ table_number: table });

    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.order_id, first.body.data.id);
  });

  test('treats table "7" and 7 as the same table', async () => {
    const table = nextTable();
    await createOrder({ table_number: table });
    const res = await createOrder({ table_number: String(table) });

    assert.strictEqual(res.status, 409);
  });

  test('simultaneous submissions (double tap) create only one order', async () => {
    const table = nextTable();
    const results = await Promise.all([createOrder({ table_number: table }), createOrder({ table_number: table })]);

    const statuses = results.map(r => r.status).sort();
    assert.deepStrictEqual(statuses, [201, 409]);
  });

  test('different tables can each have a pending order', async () => {
    const a = await createOrder({ table_number: nextTable() });
    const b = await createOrder({ table_number: nextTable() });

    assert.strictEqual(a.status, 201);
    assert.strictEqual(b.status, 201);
  });

  test('a table can order again once the previous order is confirmed', async () => {
    const table = nextTable();
    const first = await createOrder({ table_number: table });
    await updateStatus(first.body.data.id, 'confirmed');

    const second = await createOrder({ table_number: table });
    assert.strictEqual(second.status, 201);
  });

  test('the same table number at a different merchant is independent', async () => {
    const other = await registerMerchant();
    const table = nextTable();
    await createOrder({ table_number: table });

    const res = await createOrder({ merchant_id: other.id, table_number: table });
    assert.strictEqual(res.status, 201);
  });
});

describe('Table order validation', () => {
  for (const [label, items] of [
    ['negative price', [{ name: 'Refund me', price: -100, quantity: 1 }]],
    ['missing price', [{ name: 'Mystery', quantity: 1 }]],
    ['zero quantity', [{ name: 'Air', price: 5, quantity: 0 }]],
    ['fractional quantity', [{ name: 'Half', price: 5, quantity: 0.5 }]],
    ['string price', [{ name: 'Text', price: '5', quantity: 1 }]]
  ]) {
    test(`rejects item with ${label}`, async () => {
      const res = await createOrder({ table_number: nextTable(), items });
      assert.strictEqual(res.status, 400);
    });
  }

  test('rejects an empty items array', async () => {
    const res = await createOrder({ table_number: nextTable(), items: [] });
    assert.strictEqual(res.status, 400);
  });

  test('rejects an unknown merchant', async () => {
    const res = await createOrder({ merchant_id: '9999', table_number: nextTable() });
    assert.strictEqual(res.status, 404);
  });

  test('numeric merchant_id is normalised so the merchant can see and update the order', async () => {
    const created = await createOrder({ merchant_id: Number(SEED_MERCHANT.id), table_number: nextTable() });
    assert.strictEqual(created.status, 201);

    const list = await request(app).get('/api/table-orders').set('Authorization', `Bearer ${token}`);
    assert.ok(list.body.data.some(o => o.id === created.body.data.id));

    const updated = await updateStatus(created.body.data.id, 'preparing');
    assert.strictEqual(updated.status, 200);
  });

  test("another merchant cannot update someone else's order", async () => {
    const other = await registerMerchant();
    const created = await createOrder({ table_number: nextTable() });

    const res = await updateStatus(created.body.data.id, 'cancelled', other.token);
    assert.strictEqual(res.status, 403);
  });
});

describe('Socket.IO real-time events', () => {
  let baseUrl;
  let client;

  before(async () => {
    await new Promise(resolve => httpServer.listen(0, resolve));
    baseUrl = `http://localhost:${httpServer.address().port}`;
    client = ioClient(baseUrl, { transports: ['websocket'] });
    await new Promise(resolve => client.on('connect', resolve));
  });

  after(() => {
    client.close();
    io.close(); // also closes httpServer
  });

  // Resolves with the first payload of `event`, or rejects after a timeout
  const waitFor = (event, ms = 2000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
      client.once(event, data => {
        clearTimeout(timer);
        resolve(data);
      });
    });

  // Gives the server a moment to process the room join before we trigger events
  const joinRoom = (event, value) => {
    client.emit(event, value);
    return new Promise(resolve => setTimeout(resolve, 100));
  };

  test('emits new_order to the merchant room', async () => {
    await joinRoom('join_merchant', SEED_MERCHANT.id);
    const received = waitFor('new_order');

    const created = await createOrder({ table_number: nextTable() });
    const payload = await received;

    assert.strictEqual(payload.id, created.body.data.id);
  });

  test('emits order_status_changed to the table room', async () => {
    const table = nextTable();
    const created = await createOrder({ table_number: table });
    await joinRoom('join_table', String(table));
    const received = waitFor('order_status_changed');

    await updateStatus(created.body.data.id, 'ready');
    const payload = await received;

    assert.deepStrictEqual(payload, {
      order_id: created.body.data.id,
      status: 'ready',
      table_number: String(table)
    });
  });
});
