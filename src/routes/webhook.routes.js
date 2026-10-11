import express from 'express';
import crypto from 'crypto';
import { getPaymentById, db } from '../db/database.js';

const router = express.Router();

// Webhook secret for HMAC verification (env var in real deployments)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret-key';

const VALID_PAYMENT_STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled', 'refunded'];

/**
 * BUG D fix: verify the HMAC-SHA256 signature of every webhook.
 *
 * - Signs the raw request bytes (captured in server.js), not JSON.stringify(req.body),
 *   because re-serialising can change key order/whitespace and break valid signatures.
 * - Uses crypto.timingSafeEqual so the comparison time does not leak how many
 *   leading characters of a forged signature were correct.
 */
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-webhook-signature'];

  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest();

  // Both buffers are 32 bytes here thanks to the format check above
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), expectedSignature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

/**
 * POST /api/webhooks/payment-status
 *
 * Simulates external payment provider webhooks (like Powens)
 * Tests webhook signature verification and idempotency
 */
router.post('/payment-status', verifyWebhookSignature, (req, res) => {
  try {
    const { payment_id, status, event_id } = req.body;

    // event_id is required: without it a delivery cannot be de-duplicated
    if (!payment_id || !status || typeof event_id !== 'string' || !event_id.trim()) {
      return res.status(400).json({ error: 'payment_id, status and event_id required' });
    }

    // Reject unknown statuses (also blocks script injection via the status field)
    if (!VALID_PAYMENT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status', valid_statuses: VALID_PAYMENT_STATUSES });
    }

    // BUG E fix: providers retry deliveries, so the same event must only be applied once.
    // Respond 200 so the provider stops retrying, but do not touch the payment again.
    if (db.processed_webhooks.includes(event_id)) {
      return res.status(200).json({
        success: true,
        message: 'Webhook already processed',
        payment_id,
        duplicate: true
      });
    }

    const payment = getPaymentById(payment_id);
    if (!payment) {
      // Not recorded as processed: the provider's retry should succeed once
      // the payment exists (e.g. webhook arrived before the payment was saved)
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Update payment status
    payment.status = status;
    payment.webhook_received_at = new Date();

    // Mark webhook as processed only after it was applied successfully.
    // The check above and this push run in the same synchronous block, so two
    // concurrent deliveries cannot both pass the check in this single-process app.
    db.processed_webhooks.push(event_id);

    res.status(200).json({
      success: true,
      message: 'Webhook processed',
      payment_id,
      new_status: status
    });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * POST /api/webhooks/e-invoice
 *
 * Simulates e-invoice submission webhook from tax authority
 */
// Same signature check: without it anyone could mark an invoice "accepted"
router.post('/e-invoice', verifyWebhookSignature, (req, res) => {
  try {
    const { invoice_id, status, submission_id, tax_authority_id } = req.body;

    if (!invoice_id || !status) {
      return res.status(400).json({ error: 'invoice_id and status required' });
    }

    // Find invoice in database
    const invoice = db.invoices?.find(inv => inv.id === invoice_id);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Update invoice status. Optional fields are only overwritten when sent,
    // otherwise a status-only callback erased the stored submission_id.
    invoice.einvoice_status = status;
    if (submission_id) invoice.einvoice_submission_id = submission_id;
    if (tax_authority_id) invoice.tax_authority_id = tax_authority_id;
    invoice.submitted_at = new Date();

    res.status(200).json({
      success: true,
      message: 'E-invoice webhook processed',
      invoice_id,
      status
    });
  } catch (error) {
    console.error('E-invoice webhook error:', error);
    res.status(500).json({ error: 'E-invoice webhook failed' });
  }
});

export default router;
