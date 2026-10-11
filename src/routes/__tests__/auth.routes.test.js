import { describe, test } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app, SEED_MERCHANT } from './helpers.js';
import { validateEmail } from '../../utils/validation.js';

/**
 * Auth Routes Tests
 * Covers Bug C (email validation) and the broken seeded login credentials.
 */

const validRegistration = (email) => ({
  email,
  password: 'SecurePass123!',
  business_name: 'Test Co'
});

describe('Bug C: email validation', () => {
  test('validateEmail accepts common valid addresses', () => {
    for (const email of [
      'user@domain.com',
      'first.last@example.co.uk',
      'user+tag@sub.example.io',
      'x_y-z@my-company.eu'
    ]) {
      assert.strictEqual(validateEmail(email), true, `expected valid: ${email}`);
    }
  });

  test('validateEmail rejects addresses without a proper domain/TLD', () => {
    for (const email of [
      'user@domain',      // the original bug: no TLD
      'user@domain.',     // trailing dot
      'user@.com',        // empty domain label
      'user@domain.c',    // 1-letter TLD
      'userdomain.com',   // no @
      'a@b@c.com',        // two @
      'user @domain.com', // whitespace
      '@domain.com',      // empty local part
      ''
    ]) {
      assert.strictEqual(validateEmail(email), false, `expected invalid: ${JSON.stringify(email)}`);
    }
  });

  test('validateEmail rejects non-string input instead of coercing it', () => {
    assert.strictEqual(validateEmail(['user@domain.com']), false);
    assert.strictEqual(validateEmail(12345), false);
    assert.strictEqual(validateEmail(null), false);
    assert.strictEqual(validateEmail(undefined), false);
  });

  test('POST /register rejects "user@domain" with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(validRegistration('user@domain'));

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Invalid email format');
  });

  test('POST /register rejects an array email (type confusion)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(validRegistration(['array@example.com']));

    assert.strictEqual(res.status, 400);
  });

  test('POST /register accepts a valid email and returns a token', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(validRegistration('new.merchant@example.com'));

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.user.email, 'new.merchant@example.com');
    assert.ok(res.body.token);
  });

  test('POST /register treats emails case-insensitively (no duplicate accounts)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(validRegistration('MERCHANT@Test.com'));

    assert.strictEqual(res.status, 409);
  });
});

describe('Registration input validation', () => {
  test('numeric password returns 400, not 500', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'numeric.pw@example.com', password: 123456789, business_name: 'Num Co' });

    assert.strictEqual(res.status, 400);
  });

  test('short password is rejected', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'short.pw@example.com', password: 'abc', business_name: 'Short Co' });

    assert.strictEqual(res.status, 400);
  });

  test('malformed JSON body returns 400, not 500', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"email": "broken@example.com",');

    assert.strictEqual(res.status, 400);
  });
});

describe('Login', () => {
  test('seeded merchant can log in with the documented credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: SEED_MERCHANT.email, password: SEED_MERCHANT.password });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.id, SEED_MERCHANT.id);
    assert.ok(res.body.token);
  });

  test('login works regardless of email case', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'Merchant@Test.com', password: SEED_MERCHANT.password });

    assert.strictEqual(res.status, 200);
  });

  test('wrong password returns 401 with a generic message', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: SEED_MERCHANT.email, password: 'WrongPass1!' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Invalid credentials');
  });

  test('unknown email returns the same 401 message (no user enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'Whatever1!' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Invalid credentials');
  });

  test('missing fields return 400', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: SEED_MERCHANT.email });

    assert.strictEqual(res.status, 400);
  });
});
