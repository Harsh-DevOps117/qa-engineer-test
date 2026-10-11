# Fixes — EU Pay QA Assignment

Each fix lists the files changed, the important part of the diff, why I chose that approach, and how it was verified. Line numbers refer to the **fixed** files. Bug IDs match `bug-reports.md`.

**Verification for every fix:**

- `npm test`: **88 tests, 88 pass**
- **Tests fail on the old code.** I swapped each original route file back in, one at a time, and ran its test file. Every one of bugs A–G is caught by at least one test that fails on the original code and passes on the fix.

  | Original file restored | Tests failing |
  | ---------------------- | ------------- |
  | `auth.routes.js`       | 5             |
  | `payment.routes.js`    | 12            |
  | `webhook.routes.js`    | 10            |
  | `table-order.routes.js`| 12            |
  | `einvoice.routes.js`   | 5             |

- I also re-ran every curl reproduction from `bug-reports.md` against `npm start` and pasted the new responses below.

**API contracts:** no endpoint, field or event name changed. The only behaviour changes are new `400` / `401` / `404` / `409` rejections for input that used to be wrongly accepted. Webhooks now require a valid signature and an `event_id`, which is the purpose of Bugs D and E.

---

## Fix 1 (Bug A): Payment amount data type

**Files Changed:**

- src/routes/payment.routes.js (lines 17–20, 57)

**Code Changes:**

```diff
-      amount: p.amount.toString(), // ← BUG: Should be number, not string
+      amount: p.amount,
 ...
-        amount: payment.amount.toString(), // Same bug as above
+        amount: payment.amount, // BUG A fix: keep numeric type
```

**Why This Fix:** The value is already stored as a number (`createPayment` uses the parsed amount), so the correct fix is to stop converting it. `parseFloat(p.amount)` (the brief's example) would also work, but it is an unnecessary conversion. The GET responses now have the same type as the POST response.

**Testing:**

```bash
curl localhost:3000/api/payments/1 -H "Authorization: Bearer $TOKEN"
# {"success":true,"data":{"id":"1","amount":25.5,...}}
```

Tests: `payment.routes.test.js` → *Bug A* suite (list, single, POST-vs-GET consistency).

---

## Fix 2 (Bug B + Bug J): Amount validation and maximum

**Files Changed:**

- src/routes/payment.routes.js (lines 8–9, 74–94, 107)

**Code Changes:**

```diff
+const MAX_PAYMENT_AMOUNT = 50000;
 ...
-    if (!amount || isNaN(amount) || amount <= 0) {
+    let parsedAmount = NaN;
+    if (typeof amount === 'number') {
+      parsedAmount = amount;
+    } else if (typeof amount === 'string' && /^\d+(\.\d+)?$/.test(amount.trim())) {
+      parsedAmount = Number(amount);
+    }
+
+    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
       return res.status(400).json({ error: 'Valid amount is required' });
     }
+
+    // BUG B fix: enforce a per-transaction maximum
+    if (parsedAmount > MAX_PAYMENT_AMOUNT) {
+      return res.status(400).json({
+        error: `Amount exceeds maximum of ${MAX_PAYMENT_AMOUNT} per transaction`
+      });
+    }
 ...
-      amount: parseFloat(amount),
+      amount: parsedAmount,
```

**Why This Fix:**

- **One parsed value for everything.** The amount is parsed once, and that same value is checked and stored. In the original code, the checks ran on the raw input but `parseFloat()` ran afterwards, so the checks could pass on one value while a different value was saved. That is how `true` became `NaN` and `"1e400"` became `Infinity` (Bug J).
- **Numeric strings like `"25.50"` are still accepted.** The original API accepted them, and removing that would break clients. Only plain decimal strings are allowed, so hex (`"0x10"` → 16), exponents and booleans are rejected.
- **The limit is a named constant**, so it is easy to find and change, or to make per-currency later. The limit is inclusive: exactly €50,000 is allowed.

**Testing:**

```bash
curl -X POST localhost:3000/api/payments -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"amount":999999999,"currency":"EUR","customer_email":"c@test.com"}'
# {"error":"Amount exceeds maximum of 50000 per transaction"}
```

Tests: *Bug B* suite with boundaries (50000 accepted, 50000.01 rejected, string `"999999999"` rejected), plus 8 table-driven invalid-amount cases.

---

## Fix 3 (Bug C + Bug P): Email validation and normalisation

**Files Changed:**

- src/utils/validation.js (new: `validateEmail`, `normalizeEmail`)
- src/routes/auth.routes.js (lines 16–31, 78–81): uses the shared validator, adds type checks, normalises the email
- src/routes/payment.routes.js (lines 100–101): `customer_email` uses the same validator

**Code Changes:**

```diff
-  const emailRegex = /^[^\s@]+@[^\s@]+$/;
-  return emailRegex.test(email);
+const EMAIL_REGEX = /^[^\s@]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;
+export function validateEmail(email) {
+  if (typeof email !== 'string' || email.length > 254) return false;
+  return EMAIL_REGEX.test(email);
+}
```

```diff
-    if (!email || !validateEmail(email)) {
+    if (!validateEmail(req.body.email)) {
       return res.status(400).json({ error: 'Invalid email format' });
     }
+    const email = normalizeEmail(req.body.email);   // trim + lowercase
```

**Why This Fix:**

- The domain must contain at least one dot and end in a TLD of 2 or more letters. This rejects `user@domain`, `user@domain.`, `user@.com` and `a@b@c.com`, but still accepts `first.last+tag@sub.example.co.uk`.
- I deliberately did not try a "full RFC 5322" regex. Those are unreadable and still do not prove the mailbox exists; the real check is a confirmation email.
- `typeof` check: without it, `["x@y.com"]` passes, because `RegExp.test()` converts the array to a string.
- **Shared module:** payments had its own, even weaker check (`includes('@')`, which also crashed on numbers). Moving the validator to one place means both endpoints apply the same rules.
- **Lowercasing on register *and* login** prevents duplicate accounts. The seeded email is already lowercase, so existing users are not affected.
- `password` and `business_name` now also get `typeof` checks. A numeric password used to reach `bcrypt.hash` and cause a 500.

**Testing:**

```bash
curl -X POST localhost:3000/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"user@domain","password":"SecurePass123!","business_name":"No TLD Co"}'
# {"error":"Invalid email format"}
```

Tests: `auth.routes.test.js`. These include unit tests of the validator (4 valid, 9 invalid, 4 non-string cases) and endpoint tests (`user@domain`, array email, case-insensitive duplicate, numeric password).

---

## Fix 4 (Bug D + Bug I): Webhook signature verification

**Files Changed:**

- src/server.js (lines 27–36): keeps the raw body bytes
- src/routes/webhook.routes.js (lines 7–38): new `verifyWebhookSignature` middleware, applied to **both** webhook routes (lines 47 and 106)

**Code Changes:**

```diff
-app.use(express.json());
+app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
```

```js
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-webhook-signature'];
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const payload = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  const expectedSignature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest();
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), expectedSignature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  next();
}
```

**Why This Fix (and why not just uncomment the original snippet):**

1. **Raw bytes, not `JSON.stringify(req.body)`.** The provider signs the exact bytes it sends. Parsing and re-serialising can change whitespace, key order or number formatting, so correctly signed webhooks would be rejected. A test sends a signed body with extra spaces to prove this case works.
2. **`timingSafeEqual` instead of `!==`.** A normal string comparison stops at the first different character. In theory, an attacker could measure response times and work out a valid signature one character at a time. The format check (64 hex characters) runs first, so both buffers always have the same length, which `timingSafeEqual` requires.
3. **Middleware.** The e-invoice webhook had the same hole (Bug I). A reusable middleware protects both routes, and any future webhook route, with one line.
4. **Secret from the environment.** The secret is read from `WEBHOOK_SECRET`, with the old value as a default so local setup keeps working. In production the default should be removed (see the known-issues table in `bug-reports.md`).

**Manual testing helper:** `scripts/sign-webhook.js` prints the signature for a body. The Postman collection has a new **Webhooks** folder that signs requests automatically in a pre-request script.

```bash
BODY='{"payment_id":"2","status":"completed","event_id":"evt_123"}'
curl -X POST localhost:3000/api/webhooks/payment-status -H 'Content-Type: application/json' \
  -H 'x-webhook-signature: fake-signature' -d "$BODY"
# {"error":"Invalid signature"}
curl -X POST localhost:3000/api/webhooks/payment-status -H 'Content-Type: application/json' \
  -H "x-webhook-signature: $(node scripts/sign-webhook.js "$BODY")" -d "$BODY"
# {"success":true,"message":"Webhook processed","payment_id":"2","new_status":"completed"}
```

Tests: *Bug D* suite. Cases: no header, `fake-signature`, wrong secret, tampered body, valid signature, whitespace-different signed body, and an unsigned e-invoice webhook.

---

## Fix 5 (Bug E + Bug N): Webhook idempotency and status whitelist

**Files Changed:**

- src/routes/webhook.routes.js (lines 10, 49–86)

**Code Changes:**

```diff
-    if (!payment_id || !status) {
+    if (!payment_id || !status || typeof event_id !== 'string' || !event_id.trim()) {
+      return res.status(400).json({ error: 'payment_id, status and event_id required' });
+    }
+    if (!VALID_PAYMENT_STATUSES.includes(status)) {
+      return res.status(400).json({ error: 'Invalid status', valid_statuses: VALID_PAYMENT_STATUSES });
+    }
+    if (db.processed_webhooks.includes(event_id)) {
+      return res.status(200).json({ success: true, message: 'Webhook already processed', payment_id, duplicate: true });
+    }
     ...
     payment.status = status;
     payment.webhook_received_at = new Date();
+    db.processed_webhooks.push(event_id);
```

**Why This Fix:**

- **Duplicates return 200, not 409.** For the provider, a duplicate means "I already have this". An error code would make it keep retrying. `duplicate: true` lets our own logs and tests tell the two cases apart.
- **`event_id` is required.** The commented-out hint code would have done `processed_webhooks.push(undefined)`. After that, *every* webhook without an `event_id` would be treated as "already processed" and silently dropped.
- **The event is recorded only after it succeeds.** If the payment is not found (404), the event is not marked as processed. A webhook that arrives before our payment record exists can then succeed when the provider retries. A test covers this.
- **Concurrency:** the check and the `push` run in the same synchronous block, and Node runs one request at a time on a single thread, so two simultaneous deliveries cannot both pass the check. A test fires 5 identical deliveries at once and checks that exactly one is applied. With several server instances, this needs a unique constraint on `event_id` in the database instead.
- **Status whitelist (Bug N):** unknown values such as `<script>…` are rejected with 400, and the error lists the valid statuses.

**Testing:**

```bash
# same signed request twice
# 1st: {"success":true,"message":"Webhook processed","payment_id":"2","new_status":"completed"}
# 2nd: {"success":true,"message":"Webhook already processed","payment_id":"2","duplicate":true}
```

Tests: *Bug E* suite (duplicate, replay after a newer event, 5 concurrent deliveries, missing `event_id`, 404-then-retry) and *payload validation* suite.

**Not fixed here:** an event with a *new* `event_id` can still move a payment back to an earlier state, for example `refunded` → `pending`. That needs a status-transition design (see the known-issues table, item 2).

---

## Fix 6 (Bug F + K + L + M): Table orders

**Files Changed:**

- src/routes/table-order.routes.js (lines 3, 44–79, 85–86, 99–100, 143–148)

**Code Changes (Bug F core):**

```diff
+    const merchantId = String(merchant_id);
+    const tableNumber = String(table_number);
+    if (!findUserById(merchantId)) {
+      return res.status(404).json({ error: 'Merchant not found' });
+    }
+    const existingOrder = (db.table_orders || []).find(
+      o => o.merchant_id === merchantId &&
+           o.table_number === tableNumber &&
+           o.status === 'pending'
+    );
+    if (existingOrder) {
+      return res.status(409).json({ error: 'Table already has a pending order', order_id: existingOrder.id });
+    }
```

**Supporting changes:**

- **Item validation (K):** each item needs `price` as a finite number >= 0 and `quantity` as an integer >= 1.
- **Socket events (L):** `req.app.get('io')?.to(...).emit(...)`. `server.js` already registered `io` on the app, and the `?.` means the route still works if Socket.IO is not set up (for example in unit tests).
- **ID normalisation (M):** `merchant_id` and `table_number` are stored as strings. Without this, `5` and `"5"` were treated as different tables, so the duplicate check could be bypassed. Orders created with a numeric `merchant_id` were also invisible to their own merchant.

**Why This Fix:**

- **Only `pending` blocks a new order, not `confirmed` or `preparing`.** The bug is double-submission: a double tap or a network retry. Once staff have confirmed an order, a table ordering dessert is a normal new order, and blocking it would be a functional regression. A test covers this.
- **`order_id` in the 409 response.** The client can show or reuse the order that already exists instead of just failing.

**Testing:**

```bash
# same POST twice
# 1st: {"success":true,"message":"Table order created","data":{"id":"3456d4e9-…",…}}
# 2nd: {"error":"Table already has a pending order","order_id":"3456d4e9-…"}
```

Tests: `table-order.routes.test.js` (Bug F suite including `"7"` vs `7` and simultaneous submissions, item validation, numeric `merchant_id`, cross-merchant 403). Two tests use a **real Socket.IO client** to confirm `new_order` and `order_status_changed` are delivered with the expected payloads.

---

## Fix 7 (Bug G + Q): Duplicate e-invoice submission

**Files Changed:**

- src/routes/einvoice.routes.js (lines 20–27, 52–60, 70–71)

**Code Changes:**

```diff
+    if (typeof customer_siret !== 'string' || !/^\d{14}$/.test(customer_siret)) {
+      return res.status(400).json({ error: 'Valid customer SIRET required for e-invoicing (14 digits)' });
+    }
     // Find or create invoice
     ...
-    // Validate B2B requirement
-    if (!customer_siret || customer_siret.length !== 14) { ... }
+    if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
+      return res.status(409).json({
+        error: 'Invoice already submitted to tax authority',
+        submission_id: invoice.einvoice_submission_id
+      });
+    }
```

**Why This Fix:**

- **`submitted` and `accepted` are blocked; `rejected` can be resubmitted.** That matches the real process: a rejected invoice is corrected and sent again.
- **The 409 includes the existing `submission_id`.** A client that retried after a timeout can recover the original submission instead of getting a bare error.
- **SIRET validation moved before "find or create".** Invalid requests no longer leave draft invoices behind (Bug Q), and the check now requires 14 *digits*, as the error message already said.
- **Race condition:** the status is set to `submitted` before the (future) `await seqinoClient.submitInvoice()` call, and I left a comment explaining why. If someone later moves that assignment after the await, two concurrent requests could both get through. A test fires 3 concurrent submissions and expects `[200, 409, 409]`.

**Testing:**

```bash
# same submit twice
# 1st: {"success":true,…,"submission_id":"SUB-c77b18b7-…","status":"submitted"}
# 2nd: {"error":"Invoice already submitted to tax authority","submission_id":"SUB-c77b18b7-…"}
```

---

## Fix 8 (Bug H): Seeded merchant login

**Files Changed:** src/db/database.js (lines 1, 21–23)

```diff
-    password: "$2a$10$8Z3KxGXvGqJQZ.ZF9Z3KxGXvGqJQZ.ZF9Z3KxGXvGqJQZ.ZF9", // password: Test123!
+    password: bcrypt.hashSync("Test123!", 10),
```

**Why:** The old value was not a valid bcrypt hash. Hashing when seeding guarantees the hash matches the documented password, and seeding only runs once at startup.

**Testing:** `POST /api/auth/login` with the README credentials now returns `200`. Every test suite logs in as this merchant in its `before()` hook.

---

## Fix 9 (Bug O + R): Error handling and webhook data loss

- **src/server.js (lines 111–118):** body-parser errors are now client errors. Malformed JSON returns `400 {"error":"Malformed JSON body"}` and a body over 100 kB returns `413`. Before, both returned a 500 with a stack trace in the logs.
- **src/routes/webhook.routes.js (lines 120–124):** the e-invoice callback only overwrites `submission_id` and `tax_authority_id` when they are present in the callback.

---

## Supporting change: testable server

**src/server.js (lines 123–135):** the server only calls `listen()` when run directly (`npm start`), and now exports `httpServer` and `io`. Before this, importing the app in a test started a second server on port 3000. `npm start` and `npm run dev` behave exactly as before.

## Note on `npm run verify-bugs`

After the fixes, the script reports `Bugs found: 0/7`. It uses text matching that expects particular code shapes, so for some fixed bugs it prints "missing" instead of "already fixed":

- A and C: the script only checks whether the buggy text still exists.
- B: it looks for `amount > <number literal>`, but I use the `MAX_PAYMENT_AMOUNT` constant.
- D: it looks for `signature !== expectedSignature`, but I use `timingSafeEqual`.

The bugs are fixed either way; the automated tests are the actual proof.
