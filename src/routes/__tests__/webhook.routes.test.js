import { describe, test, before } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app, loginSeedMerchant, createPayment, sendWebhook, signPayload } from './helpers.js';

/**
 * Webhook Routes Tests
 * Covers Bug D (signature verification) and Bug E (idempotency) for the
 * payment-status webhook, and signature verification for the e-invoice webhook.
 */

const PAYMENT_WEBHOOK = '/api/webhooks/payment-status';
const EINVOICE_WEBHOOK = '/api/webhooks/e-invoice';

let token;
let eventCounter = 0;
const nextEventId = () => `evt_test_${++eventCounter}`;

before(async () => {
  token = await loginSeedMerchant();
});

async function newPaymentId() {
  const res = await createPayment(token);
  assert.strictEqual(res.status, 201);
  return res.body.data.id;
}

async function getPaymentStatus(id) {
  const res = await request(app).get(`/api/payments/${id}`).set('Authorization', `Bearer ${token}`);
  return res.body.data.status;
}

describe('Bug D: webhook signature verification', () => {
  test('rejects a webhook with no signature header', async () => {
    const paymentId = await newPaymentId();
    const res = await sendWebhook(
      PAYMENT_WEBHOOK,
      { payment_id: paymentId, status: 'completed', event_id: nextEventId() },
      { signature: null }
    );

    assert.strictEqual(res.status, 401);
    assert.strictEqual(await getPaymentStatus(paymentId), 'pending');
  });

  test('rejects the README example "fake-signature"', async () => {
    const paymentId = await newPaymentId();
    const res = await sendWebhook(
      PAYMENT_WEBHOOK,
      { payment_id: paymentId, status: 'completed', event_id: nextEventId() },
      { signature: 'fake-signature' }
    );

    assert.strictEqual(res.status, 401);
    assert.strictEqual(await getPaymentStatus(paymentId), 'pending');
  });

  test('rejects a well-formed signature made with the wrong secret', async () => {
    const paymentId = await newPaymentId();
    const body = JSON.stringify({ payment_id: paymentId, status: 'completed', event_id: nextEventId() });
    const wrongSecretSig = (await import('crypto')).createHmac('sha256', 'attacker-secret').update(body).digest('hex');

    const res = await sendWebhook(PAYMENT_WEBHOOK, body, { signature: wrongSecretSig });

    assert.strictEqual(res.status, 401);
  });

  test('rejects a tampered body (signature of a different payload)', async () => {
    const paymentId = await newPaymentId();
    const eventId = nextEventId();
    const signedBody = JSON.stringify({ payment_id: paymentId, status: 'failed', event_id: eventId });
    const tamperedBody = JSON.stringify({ payment_id: paymentId, status: 'completed', event_id: eventId });

    const res = await sendWebhook(PAYMENT_WEBHOOK, tamperedBody, { signature: signPayload(signedBody) });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(await getPaymentStatus(paymentId), 'pending');
  });

  test('accepts a correctly signed webhook and updates the payment', async () => {
    const paymentId = await newPaymentId();
    const res = await sendWebhook(PAYMENT_WEBHOOK, {
      payment_id: paymentId,
      status: 'completed',
      event_id: nextEventId()
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.new_status, 'completed');
    assert.strictEqual(await getPaymentStatus(paymentId), 'completed');
  });

  test('verifies the raw bytes, so formatting differences in a signed body are fine', async () => {
    const paymentId = await newPaymentId();
    // Extra whitespace: JSON.stringify(req.body) would differ from what was signed
    const rawBody = `{ "event_id": "${nextEventId()}",  "status": "completed", "payment_id": "${paymentId}" }`;

    const res = await sendWebhook(PAYMENT_WEBHOOK, rawBody);

    assert.strictEqual(res.status, 200);
  });

  test('e-invoice webhook also rejects unsigned requests', async () => {
    const res = await sendWebhook(
      EINVOICE_WEBHOOK,
      { invoice_id: 'inv-any', status: 'accepted', tax_authority_id: 'FORGED' },
      { signature: null }
    );

    assert.strictEqual(res.status, 401);
  });
});

describe('Bug E: webhook idempotency', () => {
  test('the same event delivered twice is only applied once', async () => {
    const paymentId = await newPaymentId();
    const event = { payment_id: paymentId, status: 'completed', event_id: nextEventId() };

    const first = await sendWebhook(PAYMENT_WEBHOOK, event);
    const second = await sendWebhook(PAYMENT_WEBHOOK, event);

    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200, 'duplicate should still be acknowledged so the provider stops retrying');
    assert.strictEqual(second.body.duplicate, true);
  });

  test('a replayed old event does not overwrite a newer status', async () => {
    const paymentId = await newPaymentId();
    const completedEvent = { payment_id: paymentId, status: 'completed', event_id: nextEventId() };
    const refundedEvent = { payment_id: paymentId, status: 'refunded', event_id: nextEventId() };

    await sendWebhook(PAYMENT_WEBHOOK, completedEvent);
    await sendWebhook(PAYMENT_WEBHOOK, refundedEvent);
    await sendWebhook(PAYMENT_WEBHOOK, completedEvent); // retry/replay of the first event

    assert.strictEqual(await getPaymentStatus(paymentId), 'refunded');
  });

  test('concurrent duplicate deliveries are applied exactly once', async () => {
    const paymentId = await newPaymentId();
    const event = { payment_id: paymentId, status: 'completed', event_id: nextEventId() };

    const responses = await Promise.all(Array.from({ length: 5 }, () => sendWebhook(PAYMENT_WEBHOOK, event)));

    const applied = responses.filter(r => r.status === 200 && !r.body.duplicate);
    assert.strictEqual(applied.length, 1);
    assert.ok(responses.every(r => r.status === 200));
  });

  test('event_id is required', async () => {
    const paymentId = await newPaymentId();
    const res = await sendWebhook(PAYMENT_WEBHOOK, { payment_id: paymentId, status: 'completed' });

    assert.strictEqual(res.status, 400);
  });

  test('a webhook for a not-yet-existing payment can succeed on retry', async () => {
    // Provider fires the webhook before our payment record exists
    const eventId = nextEventId();
    const early = await sendWebhook(PAYMENT_WEBHOOK, { payment_id: '9999', status: 'completed', event_id: eventId });
    assert.strictEqual(early.status, 404);

    // The 404 must not mark the event as processed, otherwise the retry is swallowed
    const paymentId = await newPaymentId();
    const retry = await sendWebhook(PAYMENT_WEBHOOK, { payment_id: paymentId, status: 'completed', event_id: eventId });
    assert.strictEqual(retry.status, 200);
    assert.notStrictEqual(retry.body.duplicate, true);
    assert.strictEqual(await getPaymentStatus(paymentId), 'completed');
  });
});

describe('Webhook payload validation', () => {
  test('rejects an unknown status such as a script injection', async () => {
    const paymentId = await newPaymentId();
    const res = await sendWebhook(PAYMENT_WEBHOOK, {
      payment_id: paymentId,
      status: '<script>alert(1)</script>',
      event_id: nextEventId()
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(await getPaymentStatus(paymentId), 'pending');
  });

  test('SQL-injection style payment_id is treated as a plain id (404)', async () => {
    const res = await sendWebhook(PAYMENT_WEBHOOK, {
      payment_id: "1' OR '1'='1",
      status: 'completed',
      event_id: nextEventId()
    });

    assert.strictEqual(res.status, 404);
  });

  test('malformed JSON returns 400', async () => {
    const res = await request(app)
      .post(PAYMENT_WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', signPayload('{"payment_id":'))
      .send('{"payment_id":');

    assert.strictEqual(res.status, 400);
  });

  test('oversized body returns 413, not 500', async () => {
    const res = await sendWebhook(PAYMENT_WEBHOOK, {
      payment_id: '1',
      status: 'completed',
      event_id: nextEventId(),
      padding: 'a'.repeat(120 * 1024) // express.json default limit is 100kb
    });

    assert.strictEqual(res.status, 413);
  });
});
