
import { createClient } from "@supabase/supabase-js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const response = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

function safeEqualHex(a, b) {
  if (typeof a !== "string" || !/^[a-f0-9]{64}$/i.test(a)) return false;
  if (typeof b !== "string" || !/^[a-f0-9]{64}$/i.test(b)) return false;

  return timingSafeEqual(
    Buffer.from(a, "hex"),
    Buffer.from(b, "hex")
  );
}

function toMinorUnits(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method not allowed" });
  }

  const apiToken = process.env.CRYPTO_PAY_API_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiToken || !supabaseUrl || !serviceRoleKey) {
    console.error("Missing environment variables");
    return response(500, { error: "Server configuration error" });
  }

  const signature =
    event.headers?.["crypto-pay-api-signature"] ??
    event.headers?.["Crypto-Pay-Api-Signature"];

  if (!signature) {
    return response(401, { error: "Missing signature" });
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64")
    : Buffer.from(event.body || "", "utf8");

  const secretKey = createHash("sha256")
    .update(apiToken, "utf8")
    .digest();

  const expectedSignature = createHmac("sha256", secretKey)
    .update(rawBody)
    .digest("hex");

  if (!safeEqualHex(signature, expectedSignature)) {
    return response(401, { error: "Invalid signature" });
  }

  let update;

  try {
    update = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return response(400, { error: "Invalid JSON" });
  }

  if (update.update_type !== "invoice_paid") {
    return response(200, { ok: true, ignored: true });
  }

  const requestDate = Date.parse(update.request_date || "");

  if (
    !Number.isFinite(requestDate) ||
    Math.abs(Date.now() - requestDate) > 5 * 60 * 1000
  ) {
    return response(401, { error: "Stale request" });
  }

  const invoice = update.payload;

  if (
    !invoice ||
    invoice.status !== "paid" ||
    invoice.currency_type !== "fiat" ||
    invoice.fiat !== "RUB" ||
    invoice.payload == null ||
    invoice.invoice_id == null
  ) {
    return response(400, { error: "Invalid invoice" });
  }

  const orderId = String(invoice.payload);
  const invoiceId = String(invoice.invoice_id);
  const paidAmount = toMinorUnits(invoice.amount);

  if (!paidAmount || !/^[0-9a-f-]{36}$/i.test(orderId)) {
    return response(400, { error: "Invalid order or amount" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: order, error: orderError } = await supabase
    .from("payment_orders")
    .select("id, amount, currency, status, invoice_id")
    .eq("id", orderId)
    .maybeSingle();

  if (orderError) {
    console.error("Order lookup failed:", orderError.message);
    return response(500, { error: "Order lookup failed" });
  }

  if (!order) {
    return response(404, { error: "Order not found" });
  }

  if (
    order.status === "paid" &&
    String(order.invoice_id) === invoiceId
  ) {
    return response(200, { ok: true, already_processed: true });
  }

  if (
    order.status !== "pending" ||
    String(order.invoice_id) !== invoiceId ||
    String(order.currency).toUpperCase() !== "RUB" ||
    toMinorUnits(order.amount) !== paidAmount
  ) {
    return response(400, { error: "Payment does not match order" });
  }

  const { data: applied, error: applyError } = await supabase.rpc(
    "pc_apply_crypto_payment",
    {
      p_order_id: orderId,
      p_invoice_id: invoiceId,
    }
  );

  if (applyError) {
    console.error("Payment application failed:", applyError.message);
    return response(500, { error: "Payment application failed" });
  }

  if (applied !== true) {
    const { data: refreshed } = await supabase
      .from("payment_orders")
      .select("status, invoice_id")
      .eq("id", orderId)
      .maybeSingle();

    if (
      refreshed?.status === "paid" &&
      String(refreshed.invoice_id) === invoiceId
    ) {
      return response(200, { ok: true, already_processed: true });
    }

    return response(409, { error: "Payment was not applied" });
  }

  return response(200, { ok: true });
};
