import { describe, test, before } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app, loginSeedMerchant, registerMerchant, createPayment } from './helpers.js';

/**
 * Payment Routes Tests
 * Covers Bug A (amount type) and Bug B (maximum amount), plus amount/email
 * type-confusion cases found during exploratory testing.
 */

let token;

before(async () => {
  token = await loginSeedMerchant();
});

describe('Bug A: amount is returned as a number', () => {
  test('GET /payments returns numeric amounts', async () => {
    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.length >= 2);
    for (const payment of res.body.data) {
      assert.strictEqual(typeof payment.amount, 'number', `payment ${payment.id} amount type`);
    }
    const seeded = res.body.data.find(p => p.id === '1');
    assert.strictEqual(seeded.amount, 25.5);
  });

  test('GET /payments/:id returns a numeric amount', async () => {
    const res = await request(app)
      .get('/api/payments/1')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.amount, 25.5);
  });

  test('amount type is consistent between POST and GET', async () => {
    const created = await createPayment(token, { amount: 19.99 });
    const fetched = await request(app)
      .get(`/api/payments/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(created.body.data.amount, 19.99);
    assert.strictEqual(fetched.body.data.amount, 19.99);
  });
});

describe('Bug B: maximum amount per transaction', () => {
  test('rejects €999,999,999', async () => {
    const res = await createPayment(token, { amount: 999999999 });

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('maximum'));
  });

  test('accepts exactly the €50,000 limit (boundary)', async () => {
    const res = await createPayment(token, { amount: 50000 });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.amount, 50000);
  });

  test('rejects one cent over the limit (boundary)', async () => {
    const res = await createPayment(token, { amount: 50000.01 });

    assert.strictEqual(res.status, 400);
  });

  test('limit also applies to amounts sent as strings', async () => {
    const res = await createPayment(token, { amount: '999999999' });

    assert.strictEqual(res.status, 400);
  });
});

describe('POST /payments validation', () => {
  test('creates a valid payment as pending', async () => {
    const res = await createPayment(token, { amount: 42.5 });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.amount, 42.5);
    assert.strictEqual(res.body.data.status, 'pending');
  });

  test('still accepts a numeric string amount (existing contract)', async () => {
    const res = await createPayment(token, { amount: '25.50' });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.amount, 25.5);
  });

  for (const [label, amount] of [
    ['zero', 0],
    ['negative', -10],
    ['boolean true (was stored as NaN)', true],
    ['"1e400" (was stored as Infinity)', '1e400'],
    ['hex string', '0x10'],
    ['array', [5]],
    ['non-numeric string', 'abc'],
    ['missing', undefined]
  ]) {
    test(`rejects ${label} amount`, async () => {
      const res = await createPayment(token, { amount });
      assert.strictEqual(res.status, 400);
    });
  }

  test('rejects unsupported currency', async () => {
    const res = await createPayment(token, { currency: 'BTC' });
    assert.strictEqual(res.status, 400);
  });

  test('rejects non-string customer_email with 400 instead of crashing (500)', async () => {
    const res = await createPayment(token, { customer_email: 12 });
    assert.strictEqual(res.status, 400);
  });

  test('rejects customer_email "@"', async () => {
    const res = await createPayment(token, { customer_email: '@' });
    assert.strictEqual(res.status, 400);
  });
});

describe('Payment authorization', () => {
  test('requires authentication', async () => {
    const res = await request(app).post('/api/payments').send({ amount: 10, currency: 'EUR', customer_email: 'a@b.com' });
    assert.strictEqual(res.status, 401);
  });

  test('rejects a forged/invalid token', async () => {
    const res = await request(app).get('/api/payments').set('Authorization', 'Bearer not-a-real-token');
    assert.strictEqual(res.status, 401);
  });

  test("a merchant cannot read another merchant's payment", async () => {
    const other = await registerMerchant();
    const res = await request(app)
      .get('/api/payments/1')
      .set('Authorization', `Bearer ${other.token}`);

    assert.strictEqual(res.status, 403);
  });

  test("a merchant's list only contains their own payments", async () => {
    const other = await registerMerchant();
    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${other.token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.count, 0);
  });
});
