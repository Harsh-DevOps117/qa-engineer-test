import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { createPayment, getPayments, getPaymentById } from '../db/database.js';
import { validateEmail } from '../utils/validation.js';

const router = express.Router();

// Per-transaction ceiling (EUR/USD/GBP). Anything above needs a separate flow.
const MAX_PAYMENT_AMOUNT = 50000;

// GET /api/payments - List all payments for authenticated merchant
router.get('/', authenticate, (req, res) => {
  try {
    const merchantId = req.user.id;
    const payments = getPayments(merchantId);

    // BUG A fix: amount is stored as a number - return it unchanged so the
    // API contract matches POST /payments (which already returns a number)
    const formattedPayments = payments.map(p => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      customer_email: p.customer_email,
      created_at: p.created_at
    }));

    res.json({
      success: true,
      data: formattedPayments,
      count: formattedPayments.length
    });
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// GET /api/payments/:id - Get single payment
router.get('/:id', authenticate, (req, res) => {
  try {
    const payment = getPaymentById(req.params.id);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Verify ownership
    if (payment.merchant_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      success: true,
      data: {
        id: payment.id,
        amount: payment.amount, // BUG A fix: keep numeric type
        currency: payment.currency,
        status: payment.status,
        customer_email: payment.customer_email,
        created_at: payment.created_at
      }
    });
  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

// POST /api/payments - Create new payment
router.post('/', authenticate, (req, res) => {
  try {
    const { amount, currency, customer_email } = req.body;

    // Validation
    // Only numbers or plain decimal strings ("25.50") are accepted. isNaN()
    // alone let `true` through (stored as NaN) and "1e400" (stored as Infinity).
    let parsedAmount = NaN;
    if (typeof amount === 'number') {
      parsedAmount = amount;
    } else if (typeof amount === 'string' && /^\d+(\.\d+)?$/.test(amount.trim())) {
      parsedAmount = Number(amount);
    }

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    // BUG B fix: enforce a per-transaction maximum
    if (parsedAmount > MAX_PAYMENT_AMOUNT) {
      return res.status(400).json({
        error: `Amount exceeds maximum of ${MAX_PAYMENT_AMOUNT} per transaction`
      });
    }

    if (!currency || !['EUR', 'USD', 'GBP'].includes(currency)) {
      return res.status(400).json({ error: 'Valid currency is required (EUR, USD, GBP)' });
    }

    // validateEmail also rejects non-strings, which previously crashed .includes()
    if (!validateEmail(customer_email)) {
      return res.status(400).json({ error: 'Valid customer email is required' });
    }

    const payment = createPayment({
      merchant_id: req.user.id,
      amount: parsedAmount,
      currency,
      customer_email,
      status: 'pending'
    });

    res.status(201).json({
      success: true,
      message: 'Payment created',
      data: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        customer_email: payment.customer_email
      }
    });
  } catch (error) {
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

export default router;
