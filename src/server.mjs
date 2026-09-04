import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getOption, reference, supportOptions, money } from "./catalog.mjs";
import { loadConfig, paymentConfigured, paypalApiConfigured } from "./config.mjs";
import { PayPalClient } from "./paypal.mjs";
import { EventStore } from "./store.mjs";
import { GitHubUpdateRegistry } from "./github.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function createApp({ config = loadConfig(), paypal = new PayPalClient(config), store = new EventStore(config.ledgerPath), github = new GitHubUpdateRegistry(config) } = {}) {
  return async function app(request, response) {
    setSecurityHeaders(response);
    try {
      const url = new URL(request.url, config.publicBaseUrl);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(response, 200, { ok: true, paymentMode: paypalApiConfigured(config) ? "paypal_api" : config.paypalMeHandle ? "paypal_me" : "unconfigured" });
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        const productId = productIdFor(url, config);
        if (!productId) return problem(response, 404, "unknown_product", "Support product is not configured.");
        const product = config.supportProducts[productId];
        const capturedMeals = await store.confirmedMealCount(1219);
        let githubSnapshot = null;
        let githubStatus = product?.githubRepository ? "unavailable" : "not_configured";
        try {
          githubSnapshot = await github.check(productId);
          if (githubSnapshot) githubStatus = githubSnapshot.stale ? "stale" : "current";
        } catch (error) {
          if (error.service !== "github") throw error;
        }
        return json(response, 200, {
          paymentConfigured: paymentConfigured(config), paymentMode: paypalApiConfigured(config) ? "paypal_api" : "paypal_me", paypalEnvironment: config.paypalEnv,
          mealsFunded: config.fundedBaseline + capturedMeals,
          productId, githubConfigured: Boolean(product?.githubRepository), githubStatus, githubSnapshot,
          reference, options: supportOptions.map((option) => ({ ...option, amount: money(option.cents) }))
        });
      }
      if (request.method === "GET" && url.pathname === "/api/update-check") {
        response.setHeader("Access-Control-Allow-Origin", "*");
        const productId = productIdFor(url, config);
        if (!productId) return problem(response, 404, "unknown_product", "Support product is not configured.");
        if (!config.supportProducts[productId]?.githubRepository) return problem(response, 503, "github_not_configured", "GitHub repository is not configured for this product.");
        try {
          const snapshot = await github.check(productId, { force: url.searchParams.get("force") === "1" });
          return json(response, 200, snapshot);
        } catch (error) {
          if (error.service === "github") return problem(response, error.status === 404 ? 404 : 502, "github_update_failed", error.message);
          throw error;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/orders") {
        const productId = productIdFor(url, config);
        if (!productId) return problem(response, 400, "unknown_product", "Support product is not configured.");
        if (!paymentConfigured(config)) return problem(response, 503, "payment_not_configured", "PayPal has not been configured. No payment was started.");
        const body = await readJson(request);
        const option = getOption(body.optionId);
        if (!option) return problem(response, 400, "invalid_option", "Choose one of the published support amounts.");
        if (!paypalApiConfigured(config)) {
          const approvalUrl = `https://paypal.me/${config.paypalMeHandle}/${money(option.cents)}USD`;
          await store.append({ type: "paypal_me_handoff", productId, optionId: option.id, amountCents: option.cents, currency: "USD" });
          return json(response, 200, { approvalUrl, amount: money(option.cents), currency: "USD", confirmationMode: "paypal_me_unconfirmed" });
        }
        const requestId = randomUUID();
        const order = await paypal.createOrder(option, requestId, productId);
        const approvalUrl = order.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href;
        if (!order.id || !approvalUrl) throw new Error("PayPal did not return an approval link.");
        await store.append({ type: "order_created", orderId: order.id, productId, optionId: option.id, amountCents: option.cents, currency: "USD", requestId });
        return json(response, 201, { orderId: order.id, approvalUrl, amount: money(option.cents), currency: "USD" });
      }
      if (request.method === "GET" && url.pathname === "/paypal/return") {
        const orderId = url.searchParams.get("token") || "";
        if (!validProviderId(orderId)) return redirect(response, "/?payment=error&reason=missing_order");
        const created = await store.findOrder(orderId);
        if (!created || created.type !== "order_created") return redirect(response, "/?payment=error&reason=unknown_order");
        const captured = await paypal.captureOrder(orderId, `capture-${orderId}`);
        const result = verifyCapture(captured, created);
        if (!result.ok) {
          await store.append({ type: "capture_rejected", orderId, reason: result.reason });
          return redirect(response, `/?payment=error&reason=${encodeURIComponent(result.reason)}`);
        }
        await store.append({ type: "payment_captured", orderId, optionId: created.optionId, amountCents: created.amountCents, currency: created.currency, captureId: result.captureId, providerStatus: captured.status });
        return redirect(response, `/?product=${encodeURIComponent(created.productId || config.defaultProductId)}&payment=completed&order=${encodeURIComponent(orderId)}`);
      }
      if (request.method === "POST" && url.pathname === "/api/webhooks/paypal") {
        if (!paypalApiConfigured(config) || !config.paypalWebhookId) return problem(response, 503, "webhook_not_configured", "Webhook verification is not configured.");
        const event = await readJson(request);
        if (!(await paypal.verifyWebhook(request.headers, event))) return problem(response, 400, "invalid_signature", "The webhook signature was not verified.");
        if (!(await store.hasEvent(event.id))) {
          await reconcileWebhookCapture(event, store);
          await store.append({ type: "paypal_webhook", providerEventId: event.id, providerEventType: event.event_type, orderId: webhookOrderId(event), resourceStatus: event.resource?.status ?? null });
        }
        return json(response, 200, { received: true });
      }
      if (request.method === "GET") return serveStatic(url.pathname, response);
      return problem(response, 404, "not_found", "Route not found.");
    } catch (error) {
      console.error(error);
      return problem(response, error.status && error.status < 500 ? 400 : 502, "payment_service_error", "The payment service could not complete that request. No payment is recorded as complete unless PayPal confirms capture.");
    }
  };
}

function verifyCapture(capture, created) {
  const unit = capture.purchase_units?.[0];
  const payment = unit?.payments?.captures?.[0];
  if (capture.status !== "COMPLETED" || payment?.status !== "COMPLETED") return { ok: false, reason: "capture_not_completed" };
  if (unit.custom_id !== created.optionId) return { ok: false, reason: "option_mismatch" };
  if (payment.amount?.currency_code !== created.currency || payment.amount?.value !== money(created.amountCents)) return { ok: false, reason: "amount_mismatch" };
  return { ok: true, captureId: payment.id };
}

function webhookOrderId(event) {
  return event.resource?.supplementary_data?.related_ids?.order_id || event.resource?.id || null;
}

async function reconcileWebhookCapture(event, store) {
  if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") return;
  const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
  if (!orderId || await store.hasCapturedOrder(orderId)) return;
  const created = await store.findOrder(orderId);
  if (!created) return;

  const capture = event.resource;
  const amountMatches = capture.amount?.currency_code === created.currency && capture.amount?.value === money(created.amountCents);
  const optionMatches = !capture.custom_id || capture.custom_id === created.optionId;
  if (capture.status !== "COMPLETED" || !amountMatches || !optionMatches || !capture.id) {
    await store.append({
      type: "capture_rejected",
      orderId,
      providerEventId: event.id,
      reason: !amountMatches ? "amount_mismatch" : !optionMatches ? "option_mismatch" : "capture_not_completed"
    });
    return;
  }

  await store.append({
    type: "payment_captured",
    orderId,
    productId: created.productId || null,
    optionId: created.optionId,
    amountCents: created.amountCents,
    currency: created.currency,
    captureId: capture.id,
    providerEventId: event.id,
    providerStatus: capture.status
  });
}

function productIdFor(url, config) {
  const requested = url.searchParams.get("product");
  const productId = requested || config.defaultProductId;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(productId)) return null;
  const configuredIds = Object.keys(config.supportProducts);
  if (configuredIds.length && !config.supportProducts[productId]) return null;
  return productId;
}

async function readJson(request, limit = 64 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) { const error = new Error("Request too large"); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { const error = new Error("Invalid JSON"); error.status = 400; throw error; }
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (!/^(index\.html|app\.js|embed\.js|styles\.css|assets\/developer-dungeon-delving-ad-hero\.png)$/.test(requested)) return problem(response, 404, "not_found", "File not found.");
  const content = await readFile(path.join(rootDir, "public", requested));
  const type = requested.endsWith(".html") ? "text/html; charset=utf-8" : requested.endsWith(".js") ? "text/javascript; charset=utf-8" : requested.endsWith(".png") ? "image/png" : "text/css; charset=utf-8";
  response.writeHead(200, { "Content-Type": type, "Cache-Control": requested === "index.html" ? "no-store" : "public, max-age=300" }); response.end(content);
}

function setSecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors *; base-uri 'none'; form-action 'self' https://www.paypal.com https://www.sandbox.paypal.com");
  response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
}
function json(response, status, body) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); }
function problem(response, status, code, message) { return json(response, status, { error: code, message }); }
function redirect(response, location) { response.writeHead(303, { Location: location, "Cache-Control": "no-store" }); response.end(); }
function validProviderId(value) { return /^[A-Z0-9-]{8,64}$/i.test(value); }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  http.createServer(createApp({ config })).listen(config.port, () => console.log(`Support applet listening on ${config.publicBaseUrl} (${config.paypalEnv})`));
}
