import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { db, findUserById } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

/**
 * GET /api/table-orders
 * List all table orders for authenticated merchant
 */
router.get('/', authenticate, (req, res) => {
  try {
    const merchantId = req.user.id;
    const orders = (db.table_orders || []).filter(o => o.merchant_id === merchantId);

    res.json({
      success: true,
      data: orders,
      count: orders.length
    });
  } catch (error) {
    console.error('Get table orders error:', error);
    res.status(500).json({ error: 'Failed to fetch table orders' });
  }
});

/**
 * POST /api/table-orders
 * Create new table order
 */
router.post('/', (req, res) => {
  try {
    const { merchant_id, table_number, items, customer_name, order_type } = req.body;

    if (!merchant_id || !table_number || !items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'merchant_id, table_number, and items array required' });
    }

    if (items.length === 0) {
      return res.status(400).json({ error: 'Order must have at least one item' });
    }

    // Each item needs a non-negative price and a positive whole quantity,
    // otherwise totals came out negative (price: -100) or null (missing price)
    const hasInvalidItem = items.some(item =>
      !item ||
      typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0 ||
      !Number.isInteger(item.quantity) || item.quantity < 1
    );
    if (hasInvalidItem) {
      return res.status(400).json({ error: 'Each item needs a price >= 0 and a whole quantity >= 1' });
    }

    // Normalise ids to strings: merchant ids from the JWT are strings, so an
    // order stored with merchant_id 1 (number) was invisible in GET and
    // un-updatable (403) for its own merchant. Same for "5" vs 5 tables.
    const merchantId = String(merchant_id);
    const tableNumber = String(table_number);

    if (!findUserById(merchantId)) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    // BUG F fix: a table can only have one pending order at a time. Prevents
    // double-taps / network retries from sending the kitchen the same order twice.
    // Confirmed/preparing orders are not blocked so a table can still order more.
    const existingOrder = (db.table_orders || []).find(
      o => o.merchant_id === merchantId &&
           o.table_number === tableNumber &&
           o.status === 'pending'
    );
    if (existingOrder) {
      return res.status(409).json({
        error: 'Table already has a pending order',
        order_id: existingOrder.id
      });
    }

    // Calculate total
    const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    const newOrder = {
      id: uuidv4(),
      merchant_id: merchantId,
      table_number: tableNumber,
      items,
      customer_name: customer_name || 'Guest',
      order_type: order_type || 'dine_in',
      status: 'pending',
      total,
      created_at: new Date(),
      updated_at: new Date()
    };

    if (!db.table_orders) db.table_orders = [];
    db.table_orders.push(newOrder);

    // Notify the merchant dashboard in real time (README: new_order event)
    req.app.get('io')?.to(`merchant_${merchantId}`).emit('new_order', newOrder);

    res.status(201).json({
      success: true,
      message: 'Table order created',
      data: newOrder
    });
  } catch (error) {
    console.error('Create table order error:', error);
    res.status(500).json({ error: 'Failed to create table order' });
  }
});

/**
 * PATCH /api/table-orders/:id/status
 * Update order status (triggers socket.io event)
 */
router.patch('/:id/status', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'served', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: 'Valid status required', 
        valid_statuses: validStatuses 
      });
    }

    const order = (db.table_orders || []).find(o => o.id === id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Verify ownership
    if (order.merchant_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    order.status = status;
    order.updated_at = new Date();

    // Emit socket event for real-time update (README: order_status_changed event)
    req.app.get('io')?.to(`table_${order.table_number}`).emit('order_status_changed', {
      order_id: order.id,
      status: status,
      table_number: order.table_number
    });

    res.json({
      success: true,
      message: 'Order status updated',
      data: order
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

export default router;
