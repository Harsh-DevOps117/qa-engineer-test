#!/usr/bin/env node
/**
 * Prints the HMAC-SHA256 signature for a webhook body, for manual testing.
 *
 * Usage:
 *   BODY='{"payment_id":"1","status":"completed","event_id":"evt_1"}'
 *   curl -X POST http://localhost:3000/api/webhooks/payment-status \
 *     -H "Content-Type: application/json" \
 *     -H "x-webhook-signature: $(node scripts/sign-webhook.js "$BODY")" \
 *     -d "$BODY"
 *
 * The body passed here must be byte-for-byte identical to the one sent.
 */
import crypto from "crypto";

const body = process.argv[2];
if (!body) {
  console.error("Usage: node scripts/sign-webhook.js '<json body>'");
  process.exit(1);
}

const secret = process.env.WEBHOOK_SECRET || "test-webhook-secret-key";
console.log(crypto.createHmac("sha256", secret).update(body).digest("hex"));
