import { describe, test, before } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app, loginSeedMerchant, registerMerchant, sendWebhook } from './helpers.js';

/**
 * E-Invoice Routes Tests
 * Covers Bug G (duplicate submissions), SIRET validation and the
 * tax-authority webhook flow.
 */

const VALID_SIRET = '73282932000074';
let token;
let invoiceCounter = 0;
const nextInvoiceId = () => `inv-test-${++invoiceCounter}`;

function submit(invoiceId, siret = VALID_SIRET, authToken = token) {
  return request(app)
    .post('/api/einvoice/submit')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ invoice_id: invoiceId, customer_siret: siret });
}

function getStatus(invoiceId, authToken = token) {
  return request(app)
    .get(`/api/einvoice/status/${invoiceId}`)
    .set('Authorization', `Bearer ${authToken}`);
}

before(async () => {
  token = await loginSeedMerchant();
});

describe('Bug G: duplicate e-invoice submissions', () => {
  test('first submission succeeds', async () => {
    const res = await submit(nextInvoiceId());

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.status, 'submitted');
    assert.match(res.body.data.submission_id, /^SUB-/);
  });

  test('second submission of the same invoice is rejected with 409', async () => {
    const invoiceId = nextInvoiceId();
    const first = await submit(invoiceId);
    const second = await submit(invoiceId);

    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.submission_id, first.body.data.submission_id);

    // The original submission must be left untouched
    const status = await getStatus(invoiceId);
    assert.strictEqual(status.body.data.submission_id, first.body.data.submission_id);
  });

  test('an invoice already accepted by the tax authority cannot be resubmitted', async () => {
    const invoiceId = nextInvoiceId();
    await submit(invoiceId);
    const webhook = await sendWebhook('/api/webhooks/e-invoice', {
      invoice_id: invoiceId,
      status: 'accepted',
      tax_authority_id: 'DGFIP-123'
    });
    assert.strictEqual(webhook.status, 200);

    const res = await submit(invoiceId);
    assert.strictEqual(res.status, 409);
  });

  test('a rejected invoice can be corrected and resubmitted', async () => {
    const invoiceId = nextInvoiceId();
    await submit(invoiceId);
    await sendWebhook('/api/webhooks/e-invoice', { invoice_id: invoiceId, status: 'rejected' });

    const res = await submit(invoiceId);
    assert.strictEqual(res.status, 200);
  });

  test('concurrent duplicate submissions produce exactly one submission', async () => {
    const invoiceId = nextInvoiceId();
    const results = await Promise.all([submit(invoiceId), submit(invoiceId), submit(invoiceId)]);

    const statuses = results.map(r => r.status).sort();
    assert.deepStrictEqual(statuses, [200, 409, 409]);
  });
});

describe('E-invoice validation and access control', () => {
  for (const [label, siret] of [
    ['letters', 'ABCDEFGHIJKLMN'],
    ['13 digits', '1234567890123'],
    ['15 digits', '123456789012345'],
    ['a number instead of a string', 73282932000074],
    ['null', null]
  ]) {
    test(`rejects SIRET: ${label}`, async () => {
      const res = await submit(nextInvoiceId(), siret);
      assert.strictEqual(res.status, 400);
    });
  }

  test('rejects a request with no SIRET field', async () => {
    const res = await request(app)
      .post('/api/einvoice/submit')
      .set('Authorization', `Bearer ${token}`)
      .send({ invoice_id: nextInvoiceId() });

    assert.strictEqual(res.status, 400);
  });

  test('an invalid request does not leave a draft invoice behind', async () => {
    const invoiceId = nextInvoiceId();
    await submit(invoiceId, 'bad');

    const status = await getStatus(invoiceId);
    assert.strictEqual(status.status, 404);
  });

  test("a merchant cannot submit another merchant's invoice", async () => {
    const invoiceId = nextInvoiceId();
    await submit(invoiceId);
    const other = await registerMerchant();

    const res = await submit(invoiceId, VALID_SIRET, other.token);
    assert.strictEqual(res.status, 403);
  });

  test('status-only webhook keeps the stored submission_id', async () => {
    const invoiceId = nextInvoiceId();
    const submitted = await submit(invoiceId);
    await sendWebhook('/api/webhooks/e-invoice', { invoice_id: invoiceId, status: 'accepted' });

    const status = await getStatus(invoiceId);
    assert.strictEqual(status.body.data.einvoice_status, 'accepted');
    assert.strictEqual(status.body.data.submission_id, submitted.body.data.submission_id);
  });

  test('requires authentication', async () => {
    const res = await request(app).post('/api/einvoice/submit').send({ invoice_id: 'x', customer_siret: VALID_SIRET });
    assert.strictEqual(res.status, 401);
  });
});
