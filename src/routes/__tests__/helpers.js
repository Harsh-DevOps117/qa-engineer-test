import crypto from 'crypto';
import request from 'supertest';
import app from '../../server.js';

// Shared helpers for the route tests. Each test file runs in its own process
// under `node --test`, so every file starts with a freshly seeded database.

export { app };

export const SEED_MERCHANT = { id: '1', email: 'merchant@test.com', password: 'Test123!' };

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret-key';

export async function loginSeedMerchant() {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: SEED_MERCHANT.email, password: SEED_MERCHANT.password });
  if (res.status !== 200) {
    throw new Error(`Seed merchant login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

let counter = 0;
export async function registerMerchant() {
  counter += 1;
  const res = await request(app)
    .post('/api/auth/register')
    .send({
      email: `merchant${counter}.${Date.now()}@example.com`,
      password: 'SecurePass123!',
      business_name: `Test Business ${counter}`
    });
  if (res.status !== 201) {
    throw new Error(`Registration failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.user.id, token: res.body.token };
}

export function signPayload(rawBody) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

/**
 * Sends a webhook the way a provider would: the exact raw JSON bytes plus an
 * HMAC signature of those bytes. Pass `signature` to override (e.g. forged).
 */
export function sendWebhook(path, body, { signature } = {}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const req = request(app)
    .post(path)
    .set('Content-Type', 'application/json');
  const sig = signature === undefined ? signPayload(rawBody) : signature;
  if (sig !== null) req.set('x-webhook-signature', sig);
  return req.send(rawBody);
}

export async function createPayment(token, overrides = {}) {
  const res = await request(app)
    .post('/api/payments')
    .set('Authorization', `Bearer ${token}`)
    .send({ amount: 42.5, currency: 'EUR', customer_email: 'customer@example.com', ...overrides });
  return res;
}
