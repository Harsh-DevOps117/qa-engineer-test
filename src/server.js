import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { resolve } from "path";
import { fileURLToPath } from "url";
import authRoutes from "./routes/auth.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import tableOrderRoutes from "./routes/table-order.routes.js";
import einvoiceRoutes from "./routes/einvoice.routes.js";
import { initDatabase } from "./db/database.js";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
// Keep the raw request bytes so webhook signatures can be verified against
// exactly what the provider signed (re-serialising req.body is not reliable).
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// Initialize database
initDatabase();

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("📱 Client connected:", socket.id);

  // Join merchant room for real-time updates
  socket.on("join_merchant", (merchantId) => {
    socket.join(`merchant_${merchantId}`);
    console.log(`Merchant ${merchantId} joined room`);
  });

  // Join table room for order updates
  socket.on("join_table", (tableNumber) => {
    socket.join(`table_${tableNumber}`);
    console.log(`Joined table ${tableNumber} room`);
  });

  socket.on("disconnect", () => {
    console.log("📱 Client disconnected:", socket.id);
  });
});

// Make io accessible in routes (for emitting events)
app.set("io", io);

// Routes
app.get("/", (req, res) => {
  res.json({
    message: "EU Pay QA Test API",
    version: "1.0.0",
    features: [
      "🔐 Authentication (JWT)",
      "💳 Payment Processing",
      "🪝 Webhook Handling",
      "🍽️ Table Orders (Socket.IO)",
      "📄 E-Invoicing",
    ],
    endpoints: [
      "POST /api/auth/register",
      "POST /api/auth/login",
      "GET /api/payments",
      "POST /api/payments",
      "GET /api/payments/:id",
      "POST /api/webhooks/payment-status",
      "POST /api/webhooks/e-invoice",
      "GET /api/table-orders",
      "POST /api/table-orders",
      "PATCH /api/table-orders/:id/status",
      "POST /api/einvoice/submit",
      "GET /api/einvoice/status/:invoice_id",
    ],
    socket_events: [
      "join_merchant",
      "join_table",
      "new_order",
      "order_status_changed",
    ],
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/table-orders", tableOrderRoutes);
app.use("/api/einvoice", einvoiceRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Error handler
app.use((err, req, res, next) => {
  // Malformed JSON is a client error, not a server failure
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON body" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// Only bind the port when run directly (npm start), so tests can import the
// app without starting a second server or holding port 3000.
const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  httpServer.listen(PORT, () => {
    console.log(`✅ EU Pay QA Test API running on http://localhost:${PORT}`);
    console.log(`📖 Visit http://localhost:${PORT} for available endpoints`);
    console.log(`🔌 Socket.IO ready for real-time updates`);
  });
}

export { httpServer, io };
export default app;
