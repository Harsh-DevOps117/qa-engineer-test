# Test Plan — Webhook Payment Flow

**Feature:** `POST /api/webhooks/payment-status`. The payment provider (for example Powens) tells EU Pay that a payment's status changed.
**Goal:** Only genuine, correctly signed events change a payment, each event is applied exactly once, and bad input is rejected without side effects.

---

## 1. Test Scope

**In scope**

- Request authentication: HMAC-SHA256 signature in `x-webhook-signature`
- Payload validation: `payment_id`, `status`, `event_id`, JSON format
- Idempotency: duplicate, retried, replayed and concurrent deliveries
- State changes: payment status and `webhook_received_at`, read back through `GET /api/payments/:id`
- Error handling: response codes the provider relies on (2xx = stop retrying; 4xx/5xx = retry or alert)
- The tax-authority webhook `POST /api/webhooks/e-invoice`, for signature checks only, since it uses the same middleware

**Out of scope**

- UI, mobile apps and merchant dashboards (apart from noting XSS risk in values we store)
- Performance and load testing (only a small concurrency test is included)
- The provider's own retry schedule and delivery guarantees
- Real database persistence, multi-instance behaviour and restart durability (the DB is in-memory; these are noted as risks in §7)

## 2. Test Environment

| Item | Value |
|------|-------|
| API | `http://localhost:3000` (`npm start`) |
| Automated tests | Node built-in test runner + supertest, `npm test`. Each test file runs in its own process with a freshly seeded DB |
| Webhook simulator | curl + `scripts/sign-webhook.js` to compute signatures. Postman collection → *Webhooks* folder (signs automatically in a pre-request script) |
| Secret | `WEBHOOK_SECRET` env var (default `test-webhook-secret-key`) |
| Database | In-memory and reset on every restart. Seed: merchant `1` (`merchant@test.com` / `Test123!`), payments `1` (completed) and `2` (pending) |
| Node | 20+ (tested on 24.16) |

**Signing a manual request**

```bash
BODY='{"payment_id":"2","status":"completed","event_id":"evt_manual_1"}'
SIG=$(node scripts/sign-webhook.js "$BODY")
curl -i -X POST localhost:3000/api/webhooks/payment-status \
  -H 'Content-Type: application/json' -H "x-webhook-signature: $SIG" -d "$BODY"
```

**Test data rule:** each case creates its own `pending` payment and uses a unique `event_id`, so cases do not depend on each other or on the order they run in.

## 3. Test Scenarios

Priority: **P1** = must pass before release, **P2** = should pass, **P3** = nice to have.
Coverage: **Auto** = covered in `src/routes/__tests__/webhook.routes.test.js` (unless another file is named), **Manual** = curl/Postman. Result = result on the fixed build.

| ID | Scenario | Steps | Expected result | Pri | Coverage | Result |
|----|----------|-------|-----------------|-----|----------|--------|
| WH-01 | Valid webhook with correct signature | Sign `{payment_id, status:"completed", event_id}` and send | `200`, `new_status: completed`. GET shows `completed` | P1 | Auto | Pass |
| WH-02 | Invalid signature | Send with `x-webhook-signature: fake-signature` | `401 Invalid signature`. Payment still `pending` | P1 | Auto | Pass |
| WH-03 | Missing signature header | Send with no header | `401`. No state change | P1 | Auto | Pass |
| WH-04 | Signature made with the wrong secret | 64-hex HMAC made with another key | `401` | P1 | Auto | Pass |
| WH-05 | Tampered body | Sign body with `failed`, send body with `completed` | `401`. Payment still `pending` | P1 | Auto | Pass |
| WH-06 | Duplicate webhook (same `event_id` twice) | Send the same signed request twice | Both `200`. 2nd has `duplicate: true`. Status applied once | P1 | Auto | Pass |
| WH-07 | Webhook replay (old `event_id`) | `completed` (evt_A) → `refunded` (evt_B) → re-send evt_A | Final status `refunded` | P1 | Auto | Pass |
| WH-08 | Concurrent duplicate deliveries | Send 5 identical requests in parallel | All `200`. Exactly 1 without `duplicate: true` | P1 | Auto | Pass |
| WH-09 | Webhook for non-existent payment | `payment_id: "9999"` | `404 Payment not found` | P1 | Auto | Pass |
| WH-10 | Webhook arrives before the payment is created | Send for a missing payment (404), create the payment, retry the **same** `event_id` | Retry returns `200` and is applied. The 404 did not mark the event as processed | P1 | Auto | Pass |
| WH-11 | Missing fields | Omit `payment_id`, `status` or `event_id`, one at a time | `400`. No state change | P1 | Auto (`event_id`), Manual (others) | Pass |
| WH-12 | Malformed JSON | Body `{"payment_id":` | `400 Malformed JSON body` (not 500) | P2 | Auto | Pass |
| WH-13 | SQL injection in `payment_id` | `"1' OR '1'='1"` | `404`. Treated as a plain string, no other payment changed | P2 | Auto | Pass |
| WH-14 | XSS in `status` | `"<script>alert(1)</script>"` | `400 Invalid status`. Nothing stored | P2 | Auto | Pass |
| WH-15 | Multiple webhooks for one payment, different statuses, in order | `processing` → `completed` → `refunded`, each with a new `event_id` | Each `200`. Final status `refunded` | P2 | Manual | Pass |
| WH-16 | Same, delivered **out of order** | `refunded` (evt_a), then a delayed `pending` (evt_b) | Should be ignored, or rejected as an invalid transition | P1 | Manual | **Fail: known issue** (payment goes back to `pending`; see §7 R2) |
| WH-17 | Signature check uses the raw body | Sign and send JSON with extra whitespace/different key order | `200` | P2 | Auto | Pass |
| WH-18 | Signature timing attack | Compare response times for signatures that are wrong in the 1st vs the 63rd character (1,000 requests each) | No statistically meaningful difference. The code uses `crypto.timingSafeEqual` (checked in code review) | P3 | Manual + code review | Pass (median 346 µs vs 346 µs over 1,000 requests each, localhost) |
| WH-19 | Unsigned e-invoice webhook | `POST /api/webhooks/e-invoice` without a signature | `401` | P1 | Auto | Pass |

## 4. Security Tests

| Area | What is checked | Cases |
|------|-----------------|-------|
| **Signature verification (HMAC-SHA256)** | Missing, malformed, wrong-secret and tampered signatures are all rejected *before* anything is read or written. The HMAC is computed over the raw bytes, and the comparison is constant-time | WH-02…05, WH-17, WH-18, WH-19 |
| **Replay attack prevention** | A captured, correctly signed request cannot be applied twice | WH-06, WH-07, WH-08 |
| **Replay limits (gap)** | Event IDs are only kept in memory, and the signature has no timestamp, so after a restart an old captured request is accepted again | Documented as risk R3, not automated |
| **SQL / NoSQL injection** | Injection strings in `payment_id` and `event_id` are treated as plain values | WH-13 |
| **XSS in stored values** | `status` is checked against a whitelist, so scripts never reach dashboards | WH-14 |
| **Information leakage** | Error responses contain no stack traces or secrets (malformed JSON gives a clean 400) | WH-12 |

## 5. Edge Cases

| Case | Input | Expected | Coverage |
|------|-------|----------|----------|
| Very large `payment_id` | 10,000-character string | `404`, no crash. Body is under express's 100 kB limit | Manual: Pass |
| Oversized body | > 100 kB JSON | `413 Request body too large` (was `500` before the fix) | Auto: Pass |
| Unicode in `status` | `"completé"`, `"✅"` | `400 Invalid status` | Manual: Pass |
| Null / empty `event_id` | `null`, `""`, `"   "` | `400` | Auto (`missing`), Manual (`""`, whitespace): Pass |
| Non-string `event_id` | `12345` | `400` (stops `12345` and `"12345"` being treated as different events) | Manual: Pass |
| Future timestamps | Payload with `created_at` in 2099 | The current contract has no timestamp, so it is ignored. Once timestamped signatures exist (R3), reject anything outside ±5 min | N/A, recommendation |
| Wrong `Content-Type` | `text/plain` body | Body is not parsed, so the signature check fails → `401` (fails closed) | Manual: Pass |
| Status unchanged | `completed` → `completed` with a new `event_id` | `200`, no error | Manual: Pass |

## 6. Integration Tests

| Flow | Check | Status |
|------|-------|--------|
| Webhook → payment status update → persistence | After WH-01, `GET /api/payments/:id` returns the new status with the merchant's JWT. `webhook_received_at` is set | Auto (status read back in every WH test) |
| Webhook → Socket.IO event | **Not implemented:** the payment webhook emits no socket event, so the merchant dashboard is not updated in real time. Proposed test once added: a client in `merchant_{id}` receives `payment_status_changed` within 1 s. (The table-order events *are* covered by real Socket.IO client tests in `table-order.routes.test.js`) | Gap: recommendation |
| Failed webhook → retry | A 404 does not mark the event as processed, so the provider's retry succeeds (WH-10). A 5xx is not recorded either, so it is also retried | Auto |
| E-invoice webhook → status endpoint | A signed callback updates `einvoice_status`, and a later submit returns `409` for an accepted invoice. A status-only callback keeps the stored `submission_id` | Auto (`einvoice.routes.test.js`) |

## 7. Risk Assessment

| # | Risk in production | Likelihood / Impact | How we would detect it | Mitigation |
|---|--------------------|---------------------|------------------------|------------|
| R1 | Forged webhooks mark unpaid orders as paid | Was certain before the fix / Critical | Alert on the 401 rate on webhook routes. Reconcile our payment statuses daily against the provider's API | **Fixed:** HMAC verification on both webhook routes. Rotate the secret, keep it in a secrets manager, and allow-list the provider's IPs |
| R2 | Out-of-order delivery moves a payment back to an earlier state (for example `refunded` → `pending`) | Medium / High | Audit log of status transitions, plus an alert on any "backwards" transition | Status state machine (final states cannot change) and compare the provider's event timestamp to the last applied one |
| R3 | Replay after a restart or across instances (event IDs only kept in memory) | Medium / High | Duplicate `event_id` seen in logs or the ledger | Store event IDs in the DB with a **unique constraint**, inserted in the same transaction as the status update. Use timestamped signatures with a tolerance window |
| R4 | Webhook processed but the provider sees a timeout and retries | High / Low (now that idempotency is in place) | Rate of `duplicate: true` responses | Respond quickly. Move slow work to a queue (for example SQS) after the response is sent |
| R5 | Secret leaked (the default secret is in source control) | Medium / Critical | Secret scanning in CI | Remove the default and refuse to start without `WEBHOOK_SECRET`. Support two secrets at once so it can be rotated without downtime |
| R6 | Webhooks silently stop arriving (provider outage, DNS, firewall) | Low / High | Alert when no webhooks arrive for N minutes during business hours. Count payments stuck in `pending` | A polling job that pulls the status of stale `pending` payments from the provider |
| R7 | The provider adds a new status | Medium / Medium | Our 400 `Invalid status` responses show up in the provider dashboard and our logs | Watch the provider's changelog. Whitelist is a single constant to update |
| R8 | Merchant dashboard does not update (no socket event) | Certain / Low | User reports | Emit `payment_status_changed` to `merchant_{id}` after a successful update |

**Exit criteria:** all P1 cases pass, except WH-16, which is accepted as known issue R2 and tracked separately. There are no open Critical findings, and `npm test` is green.
