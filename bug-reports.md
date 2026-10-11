# Bug Reports — EU Pay QA Assignment

All bugs below were reproduced against the running API (`npm start`, Node 24) with curl before any code was changed. Line numbers refer to the **original** files. Responses are copied from real runs (tokens and UUIDs shortened).

**Summary**

| ID  | Title                                                         | Component    | Severity | Status |
| --- | ------------------------------------------------------------- | ------------ | -------- | ------ |
| A   | Payment amount returned as a string by GET endpoints          | Payment API  | Medium   | Fixed  |
| B   | No maximum payment amount                                     | Payment API  | High     | Fixed  |
| C   | Email validation accepts addresses without a TLD              | Auth API     | Medium   | Fixed  |
| D   | Payment webhook signature is never verified                   | Webhooks     | Critical | Fixed  |
| E   | Payment webhook is not idempotent                             | Webhooks     | High     | Fixed  |
| F   | Duplicate pending orders for the same table                   | Table Orders | Medium   | Fixed  |
| G   | Same invoice can be submitted to the tax authority repeatedly | E-Invoice    | Medium   | Fixed  |
| H   | Documented seed login (`merchant@test.com`) always fails      | Database     | High     | Fixed  |
| I   | E-invoice webhook signature is never verified                 | Webhooks     | Critical | Fixed  |
| J   | Non-numeric amounts stored as `NaN` / `Infinity`              | Payment API  | High     | Fixed  |
| K   | Table order items allow negative / missing prices             | Table Orders | Medium   | Fixed  |
| L   | Socket.IO events advertised in the README are never emitted   | Table Orders | Medium   | Fixed  |
| M   | Numeric `merchant_id` makes an order invisible to its owner   | Table Orders | Medium   | Fixed  |
| N   | Webhook accepts any `status` string (stored XSS vector)       | Webhooks     | Medium   | Fixed  |
| O   | Wrong input types and malformed JSON return 500               | Several      | Low      | Fixed  |
| P   | Emails are case-sensitive, so duplicate accounts are possible | Auth API     | Low      | Fixed  |
| Q   | SIRET check is length-only; invalid requests leave drafts     | E-Invoice    | Low      | Fixed  |
| R   | E-invoice webhook erases the stored `submission_id`           | Webhooks     | Low      | Fixed  |

Bugs A–G are the seven from the brief. H–R were found during exploratory testing. A further set of risks that I reported but deliberately did **not** fix is listed at the end ([Known issues not fixed](#known-issues-not-fixed)).

> **Note on reproduction:** because of Bug H, the documented login fails on the original code. To reproduce A–G on the original code, register a merchant first and use that token:
>
> ```bash
> TOKEN=$(curl -s -X POST localhost:3000/api/auth/register -H 'Content-Type: application/json' \
>   -d '{"email":"qa@merchant.com","password":"SecurePass123!","business_name":"QA Co"}' | jq -r .token)
> ```

---

## Bug A: Payment amount returned as a string by GET endpoints

**Location:** src/routes/payment.routes.js (lines 16 and 52)
**Severity:** Medium
**Component:** Payment API

**How to Reproduce:**

1. Start server: `npm start`, then register and save `$TOKEN` (see note above)
2. Create a payment: `POST /api/payments` with `{"amount":25.5,"currency":"EUR","customer_email":"c@test.com"}`. The response has `"amount":25.5` (number)
3. `GET /api/payments` and `GET /api/payments/3` with the same token

**Expected Behavior:** `amount` is the number `25.5` in every response.

**Actual Behavior:**

```json
{"success":true,"data":[{"id":"3","amount":"25.5","currency":"EUR",...}],"count":1}
```

The same payment is a number in the POST response and a string in both GET responses.

**Impact:** Clients that sum amounts get string concatenation (`"25.5" + "100"` = `"25.5100"`), so totals, reconciliation and charts break without any visible error. The API is also inconsistent with itself, so client code has to handle both types.

**Root Cause:** `p.amount.toString()` / `payment.amount.toString()` in the response mapping. The stored value is already a number.

**Suggested Fix:** Return `p.amount` unchanged.

---

## Bug B: No maximum payment amount

**Location:** src/routes/payment.routes.js (lines 71–77)
**Severity:** High
**Component:** Payment API

**How to Reproduce:**

1. `POST /api/payments` with `{"amount":999999999,"currency":"EUR","customer_email":"c@test.com"}`

**Expected Behavior:** `400` with an error saying the amount exceeds the per-transaction maximum (€50,000 according to the brief).

**Actual Behavior:**

```json
{"success":true,"message":"Payment created","data":{"id":"4","amount":999999999,...}}
```

**Impact:** Typos (an extra 0) or fraud can create payments of any size. Business limits, AML thresholds and provider limits are not enforced at our API. If a downstream provider then rejects the payment, the error is late and confusing for the merchant.

**Root Cause:** Only `amount <= 0` is checked. There is no upper bound.

**Suggested Fix:** Add `MAX_PAYMENT_AMOUNT = 50000` and reject `amount > MAX_PAYMENT_AMOUNT` with a 400.

---

## Bug C: Email validation accepts addresses without a TLD

**Location:** src/routes/auth.routes.js (lines 10–13)
**Severity:** Medium
**Component:** Auth API

**How to Reproduce:**

1. `POST /api/auth/register` with `{"email":"user@domain","password":"SecurePass123!","business_name":"No TLD Co"}`

**Expected Behavior:** `400 {"error":"Invalid email format"}`

**Actual Behavior:**

```json
{"message":"Registration successful","user":{"id":"2","email":"user@domain",...},"token":"eyJ..."}
```

Related: `{"email":["arr@test.com"], ...}` (an **array**) also registers successfully, because `RegExp.test()` converts the array to the string `"arr@test.com"`. The array is then stored as the user's email.

**Impact:** Accounts are created with addresses that can never receive mail (password reset, receipts, invoices). An array email also corrupts the user record and the JWT payload.

**Root Cause:** `/^[^\s@]+@[^\s@]+$/` only needs one character on each side of `@`. There is no dot or TLD requirement, and no type check.

**Suggested Fix:** Check `typeof email === 'string'` and require a domain with a 2+ letter TLD, for example `/^[^\s@]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/`.

---

## Bug D: Payment webhook signature is never verified

**Location:** src/routes/webhook.routes.js (lines 18–32)
**Severity:** Critical
**Component:** Webhooks

**How to Reproduce:**

1. Create a payment (status `pending`)
2. Send the README example with a made-up signature, and then with no signature header at all:

```bash
curl -X POST localhost:3000/api/webhooks/payment-status -H 'Content-Type: application/json' \
  -H 'x-webhook-signature: fake-signature' \
  -d '{"payment_id":"3","status":"completed","event_id":"evt_1"}'
```

**Expected Behavior:** `401 Invalid signature`. Payment status unchanged.

**Actual Behavior:**

```json
{"success":true,"message":"Webhook processed","payment_id":"3","new_status":"completed"}
```

Both requests (fake signature and no header) were accepted, and the payment became `completed`.

**Impact:** Anyone who can reach the endpoint can mark any payment as `completed` (goods ship without payment), `refunded` or `failed`. Payment IDs are sequential, so an attacker can easily iterate through all of them. This is the most serious issue in the codebase.

**Root Cause:** The signature header is read but never checked. The verification code is commented out.

**Suggested Fix:** Compute `HMAC-SHA256(secret, rawBody)` and compare it to the header with `crypto.timingSafeEqual`. Reject a missing or invalid signature with 401. Uncommenting the original snippet is not enough, for two reasons:

- It hashes `JSON.stringify(req.body)` instead of the raw bytes. A provider whose JSON has different whitespace or key order would always fail verification.
- It compares with `!==`, which is not constant-time.

---

## Bug E: Payment webhook is not idempotent

**Location:** src/routes/webhook.routes.js (lines 38–44 and 56)
**Severity:** High
**Component:** Webhooks

**How to Reproduce:**

1. Send `{"payment_id":"3","status":"completed","event_id":"evt_10"}`. Response: `Webhook processed`
2. Send `{"payment_id":"3","status":"failed","event_id":"evt_11"}`. Payment is now `failed`
3. Re-send event `evt_10` (a normal provider retry)

**Expected Behavior:** Step 3 is acknowledged (`200`) but ignored. The payment stays `failed`.

**Actual Behavior:**

```json
{"success":true,"message":"Webhook processed","payment_id":"3","new_status":"completed"}
```

`GET /api/payments/3` now shows `"status":"completed"`. The retried old event overwrote the newer state.

**Impact:** Providers deliver webhooks "at least once", so retries after timeouts are normal. Without idempotency, side effects run more than once (fulfilment, emails, ledger entries), and a delayed retry can reverse a refund or failure. Captured requests can also be replayed.

**Root Cause:** `event_id` is never stored or checked, and it is not required.

**Suggested Fix:** Require `event_id`. If it was already processed, return `200` with no side effects. Record it only after the update succeeds, so that a `404` (webhook arrived before the payment existed) can still succeed when the provider retries. In production this should be a unique constraint in the database.

---

## Bug F: Duplicate pending orders for the same table

**Location:** src/routes/table-order.routes.js (lines 44–55)
**Severity:** Medium
**Component:** Table Orders

**How to Reproduce:**

1. Send the same `POST /api/table-orders` twice (simulating a double tap or a network retry):
   `{"merchant_id":"5","table_number":5,"items":[{"name":"Pizza","price":12.5,"quantity":2}]}`

**Expected Behavior:** First request `201`, second `409 Table already has a pending order`.

**Actual Behavior:** Both return `201 Table order created` with different IDs. `GET /api/table-orders` shows `count: 2`.

**Impact:** The kitchen prepares the order twice, and the customer may be billed twice or the bill has to be fixed by hand.

**Root Cause:** There is no check for an existing `pending` order for the same merchant and table.

**Suggested Fix:** Look up an existing `pending` order for `(merchant_id, table_number)` and return `409`. Compare IDs as strings, so that table `"5"` and `5` count as the same table.

---

## Bug G: Same invoice can be submitted to the tax authority repeatedly

**Location:** src/routes/einvoice.routes.js (lines 50–58)
**Severity:** Medium
**Component:** E-Invoice

**How to Reproduce:**

1. `POST /api/einvoice/submit` with `{"invoice_id":"inv-2","customer_siret":"12345678901234"}`, twice

**Expected Behavior:** Second request returns `409 Invoice already submitted to tax authority`.

**Actual Behavior:** Both return `200` with **different** submission IDs (`SUB-7d47…`, then `SUB-553d…`). The first submission ID is overwritten and lost.

**Impact:** Duplicate legal invoices are registered with the tax authority (the French e-invoicing PDP), which leads to double-declared VAT and a manual correction process. Losing the original `submission_id` also makes it harder to match the tax authority's callbacks to the right submission.

**Root Cause:** `einvoice_status` is never checked before submitting.

**Suggested Fix:** Reject with `409` when the status is `submitted` or `accepted`. Still allow resubmission after `rejected`.

---

## Bug H: Documented seed login always fails

**Location:** src/db/database.js (line 19)
**Severity:** High (it blocks the documented test flow and everything that uses seeded data)
**Component:** Database / Auth

**How to Reproduce:**

1. `POST /api/auth/login` with `{"email":"merchant@test.com","password":"Test123!"}` (exactly as in the README)

**Expected Behavior:** `200` with a token.

**Actual Behavior:** `401 {"error":"Invalid credentials"}`

**Impact:** Nobody can use the seeded merchant, so the seeded payments 1 and 2 cannot be read. The README examples and the Postman "Login" request do not work.

**Root Cause:** The hard-coded hash `$2a$10$8Z3KxGXvGqJQZ.ZF9…` is 58 characters long. A bcrypt hash is always 60, so this cannot be the hash of `Test123!`, and `bcrypt.compare` always returns false.

**Suggested Fix:** Generate the hash when seeding: `bcrypt.hashSync("Test123!", 10)`.

---

## Bug I: E-invoice webhook signature is never verified

**Location:** src/routes/webhook.routes.js (line 75)
**Severity:** Critical
**Component:** Webhooks / E-Invoice

**How to Reproduce:**

1. Submit invoice `inv-1`
2. With no signature at all:

```bash
curl -X POST localhost:3000/api/webhooks/e-invoice -H 'Content-Type: application/json' \
  -d '{"invoice_id":"inv-1","status":"accepted","tax_authority_id":"FORGED"}'
```

**Actual Behavior:** `200`. `GET /api/einvoice/status/inv-1` then shows `"einvoice_status":"accepted","tax_authority_id":"FORGED"`.

**Expected Behavior:** `401`.

**Impact:** The same class of problem as Bug D. Anyone can fake the tax authority's decision on an invoice.

**Root Cause / Fix:** This route has no verification at all. The same signature middleware as Bug D should be applied.

---

## Bug J: Non-numeric amounts stored as `NaN` / `Infinity`

**Location:** src/routes/payment.routes.js (lines 71 and 89)
**Severity:** High
**Component:** Payment API

**How to Reproduce:** `POST /api/payments` with `"amount": true`, and again with `"amount": "1e400"`.

**Actual Behavior:** Both return `201` with `"amount": null`. `GET /api/payments` then lists them as `"NaN"` and `"Infinity"`.

**Expected Behavior:** `400 Valid amount is required`.

**Impact:** Payment records that cannot be settled, and broken totals in reports. `"1e400"` also gets past any maximum check that only compares the raw input.

**Root Cause:** `isNaN(true)` is `false`, and `parseFloat(true)` is `NaN`. `"1e400"` parses to `Infinity`.

**Suggested Fix:** Accept only numbers or plain decimal strings, and require `Number.isFinite`.

---

## Bug K: Table order items allow negative / missing prices

**Location:** src/routes/table-order.routes.js (line 58)
**Severity:** Medium
**Component:** Table Orders

**How to Reproduce:** `POST /api/table-orders` (no authentication needed) with `items: [{"name":"Refund me","price":-100,"quantity":1}]`. Then try an item with no `price`.

**Actual Behavior:** `201` with `total: -100`. With the missing price, `total: null` (`NaN`).

**Expected Behavior:** `400`.

**Impact:** Negative or invalid totals reach billing. This endpoint does not require authentication, so anyone can create these orders.

**Suggested Fix:** Each item must have `price` as a finite number >= 0 and `quantity` as an integer >= 1.

---

## Bug L: Socket.IO events advertised in the README are never emitted

**Location:** src/routes/table-order.routes.js (lines 76–77 and 120–125)
**Severity:** Medium
**Component:** Table Orders (real-time)

**How to Reproduce:**

1. Connect a Socket.IO client (for example the README's HTML snippet or `socket.io-client`) and emit `join_merchant` `"5"` and `join_table` `42`
2. `POST /api/table-orders` for merchant 5, table 42
3. `PATCH /api/table-orders/:id/status` with `{"status":"confirmed"}`

**Actual Behavior:** The client receives no events at all.

**Expected Behavior:** `new_order` is sent to `merchant_{id}` and `order_status_changed` is sent to `table_{n}`, as documented.

**Impact:** The real-time feature does not work. Kitchen screens and customers never see new orders or status changes unless they reload.

**Root Cause:** Both `emit` calls are commented out, and they use an `io` variable that does not exist in the route.

**Suggested Fix:** Use `req.app.get('io')`, which `server.js` already sets.

---

## Bug M: Numeric `merchant_id` makes an order invisible to its owner

**Location:** src/routes/table-order.routes.js (lines 34 and 62)
**Severity:** Medium
**Component:** Table Orders

**How to Reproduce:** Create an order with `"merchant_id": 1` (a number) and log in as merchant 1.

**Actual Behavior:** The order is not in `GET /api/table-orders`, and `PATCH …/status` returns `403 Access denied` to its own merchant. Orders for unknown merchants (`"merchant_id":"999"`) are also accepted.

**Root Cause:** User IDs from the JWT are strings, the comparisons use `===`, and the ID sent in the request is stored without conversion.

**Suggested Fix:** Convert `merchant_id` and `table_number` to strings, and return `404` for unknown merchants.

---

## Bug N: Webhook accepts any `status` string

**Location:** src/routes/webhook.routes.js (line 52)
**Severity:** Medium
**Component:** Webhooks

**How to Reproduce:** Send a payment webhook with `"status":"<script>alert(1)</script>"`.

**Actual Behavior:** The value is stored and returned by `GET /api/payments/3`.

**Impact:** Stored XSS in any dashboard that renders the status, and payments end up in states no other code understands.

**Suggested Fix:** Only accept statuses from a fixed list (whitelist).

---

## Bug O: Wrong input types and malformed JSON return 500

**Severity:** Low
**Component:** Payment API, Auth API, server

| Request                                       | Actual                                     | Expected |
| --------------------------------------------- | ------------------------------------------ | -------- |
| `POST /api/payments` with `customer_email: 12` | `500 Failed to create payment`             | 400      |
| `POST /api/auth/register` with `password: 123456789` | `500 Registration failed`           | 400      |
| Any POST with body `{bad`                     | `500 Something went wrong!` + stack trace in logs | 400 |
| Any POST with a body over 100 kB              | `500 Something went wrong!`                | 413      |

**Root Cause:** String methods (`.includes`, `.length`) and `bcrypt.hash` are called on non-strings. Body-parser errors fall through to the generic 500 handler.

**Impact:** Client errors look like server failures. That creates false alarms in monitoring and hides real 500s.

---

## Bug P: Emails are case-sensitive

**Location:** src/routes/auth.routes.js (line 35)
**Severity:** Low
**Component:** Auth API

`POST /api/auth/register` with `MERCHANT@test.com` succeeds even though `merchant@test.com` exists. The result is two accounts for one mailbox, and users who type a capital letter cannot log in.

**Suggested Fix:** Trim and lowercase the email when registering and logging in.

---

## Bug Q: SIRET check is length-only; invalid requests leave drafts

**Location:** src/routes/einvoice.routes.js (lines 20–48)
**Severity:** Low
**Component:** E-Invoice

- `"customer_siret":"ABCDEFGHIJKLMN"` is accepted and submitted, but a SIRET is 14 **digits**.
- A request with an invalid SIRET returns 400, but it still leaves a draft invoice behind (`GET /api/einvoice/status/inv-4` returns `not_submitted` instead of 404). This is because the invoice is created before the input is validated.

**Suggested Fix:** Validate with `/^\d{14}$/` before creating anything.

---

## Bug R: E-invoice webhook erases the stored `submission_id`

**Location:** src/routes/webhook.routes.js (line 91)
**Severity:** Low
**Component:** Webhooks / E-Invoice

A status-only callback (`{"invoice_id":"inv-1","status":"accepted"}`) sets `einvoice_submission_id` to `undefined`. After that, the status endpoint no longer returns the submission ID.

**Suggested Fix:** Only overwrite optional fields when they are present in the callback.

---

## Known issues not fixed

These were confirmed during testing but **not** fixed. Each needs a product or architecture decision, or would change an existing API or socket contract, which the brief asks us to avoid. They are listed in priority order.

| # | Issue | Evidence | Severity | Recommendation |
|---|-------|----------|----------|----------------|
| 1 | **Socket.IO rooms have no authentication.** Any client can `join_merchant` with any ID. | An anonymous client joined `merchant_1` and received a new order including the customer's name ("Jane Doe") | High | Require a JWT in the socket handshake (`io.use`), and only allow joining your own merchant room. Use a signed table token for table rooms |
| 2 | **Out-of-order webhooks can move a payment back to an earlier state.** Idempotency only stops the *same* event; a delayed event with a *different* `event_id` still applies | `refunded` (evt_a), then `pending` (evt_b): payment ends as `pending` | High | Add a state machine (for example, `refunded` is final) and/or compare provider event timestamps |
| 3 | **No replay window on signatures.** Processed event IDs are kept in memory, so after a restart a captured signed request can be replayed | By design of the in-memory DB | Medium | Use timestamped signatures (`t=…,v1=…`, as Stripe does) with about 5 minutes of tolerance, and store event IDs persistently with a unique constraint |
| 4 | **Login timing reveals which emails are registered** | Average 60.5 ms for an existing email vs 0.7 ms for an unknown one (5 runs each) | Medium | Run a bcrypt compare against a dummy hash when the user does not exist. Add rate limiting |
| 5 | **No rate limiting** on login, registration or the public table-order endpoint | — | Medium | `express-rate-limit` or a limit at the gateway |
| 6 | **Hard-coded secrets.** The JWT secret is duplicated in two files. The webhook secret is now read from `WEBHOOK_SECRET` but still has a default | — | Medium | Load all secrets from the environment and refuse to start in production if they are missing |
| 7 | `POST /api/table-orders` is unauthenticated | Probably intended (customer QR ordering) | Low | Signed table/QR token |
| 8 | E-invoice webhook has no idempotency or status whitelist, and overwrites `submitted_at` on every callback | — | Low | Same pattern as the payment webhook (needs an `event_id` from the tax authority, which changes the contract) |
| 9 | Amounts with more than 2 decimals are accepted (`10.999`) | `201` | Low | Reject, or store amounts as integer cents |
| 10 | `cors()` and Socket.IO allow every origin (`*`) | — | Low | Restrict to known front-end origins |
