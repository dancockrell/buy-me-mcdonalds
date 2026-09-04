import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { EventStore } from "../src/store.mjs";
import { PayPalClient } from "../src/paypal.mjs";

test("PayPal.Me mode accepts only catalog IDs and constructs an exact USD request", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "support-applet-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const config = loadConfig({ PORT: "0", PUBLIC_BASE_URL: "http://127.0.0.1", PAYPAL_ME_HANDLE: "Morasoom", RECEIPT_LEDGER_PATH: path.join(temp, "events.jsonl") });
  const server = http.createServer(createApp({ config, store: new EventStore(config.ledgerPath) }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const configResponse = await fetch(`${base}/api/config`).then((response) => response.json());
  assert.equal(configResponse.paymentMode, "paypal_me");
  assert.equal(configResponse.mealsFunded, 0);
  assert.equal(configResponse.githubStatus, "not_configured");
  assert.equal(configResponse.reference.fry.unroundedValue, 0.045641);

  const orderResponse = await fetch(`${base}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optionId: "quarter_pounder_cheese_meal" }) });
  assert.equal(orderResponse.status, 200);
  const order = await orderResponse.json();
  assert.equal(order.approvalUrl, "https://paypal.me/Morasoom/12.19USD");
  assert.equal(order.confirmationMode, "paypal_me_unconfirmed");

  const invalid = await fetch(`${base}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optionId: "attacker_amount_999" }) });
  assert.equal(invalid.status, 400);
  const ledger = await readFile(config.ledgerPath, "utf8");
  assert.match(ledger, /"type":"paypal_me_handoff"/);
  assert.doesNotMatch(ledger, /activeHours|objectiveCount|ip|email/i);
});

test("meal total combines a verified baseline with unique confirmed captures", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "support-meals-"));
  const ledgerPath = path.join(temp, "events.jsonl");
  const store = new EventStore(ledgerPath);
  await store.append({ type: "payment_captured", orderId: "ORDER-A", optionId: "quarter_pounder_cheese_meal", amountCents: 1219 });
  await store.append({ type: "payment_captured", orderId: "ORDER-A", optionId: "quarter_pounder_cheese_meal", amountCents: 1219 });
  await store.append({ type: "payment_captured", orderId: "ORDER-B", optionId: "hamburger", amountCents: 289 });
  await store.append({ type: "payment_captured", orderId: "ORDER-C", optionId: "future_larger_choice", amountCents: 1500 });
  const config = loadConfig({ PORT: "0", PUBLIC_BASE_URL: "http://127.0.0.1", PAYPAL_ME_HANDLE: "Morasoom", RECEIPT_LEDGER_PATH: ledgerPath, QPC_MEALS_FUNDED_BASELINE: "4" });
  const server = http.createServer(createApp({ config, store }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const body = await fetch(`http://127.0.0.1:${server.address().port}/api/config`).then((response) => response.json());
    assert.equal(body.mealsFunded, 6);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test("each product receives its own GitHub snapshot in the update endpoint and support page", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "support-github-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const config = loadConfig({
    PORT: "0",
    PUBLIC_BASE_URL: "http://127.0.0.1",
    PAYPAL_ME_HANDLE: "Morasoom",
    RECEIPT_LEDGER_PATH: path.join(temp, "events.jsonl"),
    DEFAULT_PRODUCT_ID: "pirate-island",
    SUPPORT_PRODUCTS_JSON: JSON.stringify({
      "pirate-island": "owner/pirate-game",
      "book-reader": "owner/book-reader"
    })
  });
  const calls = [];
  const snapshots = {
    "pirate-island": { repository: "owner/pirate-game", commitCount: 87, pullRequestCount: 14, checkedAt: "2026-09-04T00:00:00Z", stale: false },
    "book-reader": { repository: "owner/book-reader", commitCount: 203, pullRequestCount: 31, checkedAt: "2026-09-04T00:00:00Z", stale: false }
  };
  const github = { check: async (productId, options = {}) => { calls.push({ productId, options }); return snapshots[productId]; } };
  const server = http.createServer(createApp({ config, store: new EventStore(config.ledgerPath), github }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const updateResponse = await fetch(`${base}/api/update-check?product=book-reader&force=1`);
  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await updateResponse.json(), snapshots["book-reader"]);
  assert.deepEqual(calls[0], { productId: "book-reader", options: { force: true } });

  const pageConfig = await fetch(`${base}/api/config?product=pirate-island`).then((response) => response.json());
  assert.equal(pageConfig.productId, "pirate-island");
  assert.equal(pageConfig.githubStatus, "current");
  assert.equal(pageConfig.githubSnapshot.commitCount, 87);
  assert.equal(pageConfig.githubSnapshot.pullRequestCount, 14);

  const unknown = await fetch(`${base}/api/update-check?product=not-allowed`);
  assert.equal(unknown.status, 404);
});

test("a GitHub outage does not take down the support menu", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "support-github-outage-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const config = loadConfig({ PORT: "0", PUBLIC_BASE_URL: "http://127.0.0.1", PAYPAL_ME_HANDLE: "Morasoom", RECEIPT_LEDGER_PATH: path.join(temp, "events.jsonl"), GITHUB_REPOSITORY: "owner/private-game" });
  const github = { check: async () => { const error = new Error("GitHub update request could not be completed."); error.service = "github"; error.status = 502; throw error; } };
  const server = http.createServer(createApp({ config, store: new EventStore(config.ledgerPath), github }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/config`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.githubStatus, "unavailable");
  assert.equal(body.githubSnapshot, null);
  assert.equal(body.options.length, 5);
});

test("PayPal API client keeps credentials server-side and submits the server amount", async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 300 }), { status: 200 });
    return new Response(JSON.stringify({ id: "ORDER123", links: [{ rel: "approve", href: "https://paypal.test/approve" }] }), { status: 201 });
  };
  const config = loadConfig({ PUBLIC_BASE_URL: "https://support.example", PAYPAL_CLIENT_ID: "client", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_ME_HANDLE: "Morasoom" });
  const paypal = new PayPalClient(config, mockFetch);
  await paypal.createOrder({ id: "hamburger", label: "Hamburger", cents: 289 }, "request-1");
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.headers.Authorization, /^Basic /);
  assert.doesNotMatch(calls[1].options.body, /client|secret/);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.purchase_units[0].amount.value, "2.89");
  assert.equal(body.purchase_units[0].custom_id, "hamburger");
  assert.equal(body.payment_source.paypal.experience_context.return_url, "https://support.example/paypal/return?product=default");
});

test("webhook events are accepted only after PayPal verification and are idempotent", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "support-webhook-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const config = loadConfig({ PORT: "0", PUBLIC_BASE_URL: "http://127.0.0.1", PAYPAL_CLIENT_ID: "client", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_WEBHOOK_ID: "WEBHOOK1", RECEIPT_LEDGER_PATH: path.join(temp, "events.jsonl") });
  const paypal = { verifyWebhook: async () => true };
  const store = new EventStore(config.ledgerPath);
  await store.append({ type: "order_created", orderId: "ORDER-QPC", optionId: "quarter_pounder_cheese_meal", amountCents: 1219, currency: "USD" });
  await store.append({ type: "order_created", orderId: "ORDER-SMALL", optionId: "hamburger", amountCents: 289, currency: "USD" });
  const server = http.createServer(createApp({ config, paypal, store }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/webhooks/paypal`;
  const qpcEvent = { id: "WH-QPC", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPTURE-QPC", status: "COMPLETED", custom_id: "quarter_pounder_cheese_meal", amount: { currency_code: "USD", value: "12.19" }, supplementary_data: { related_ids: { order_id: "ORDER-QPC" } } } };
  const smallEvent = { id: "WH-SMALL", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPTURE-SMALL", status: "COMPLETED", custom_id: "hamburger", amount: { currency_code: "USD", value: "2.89" }, supplementary_data: { related_ids: { order_id: "ORDER-SMALL" } } } };

  for (let i = 0; i < 2; i++) assert.equal((await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(qpcEvent) })).status, 200);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(smallEvent) })).status, 200);

  const events = await store.all();
  assert.equal(events.filter((item) => item.providerEventId === "WH-QPC" && item.type === "paypal_webhook").length, 1);
  assert.equal(events.filter((item) => item.orderId === "ORDER-QPC" && item.type === "payment_captured").length, 1);
  assert.equal(await store.confirmedMealCount(1219), 1);
  const pageConfig = await fetch(`http://127.0.0.1:${server.address().port}/api/config`).then((response) => response.json());
  assert.equal(pageConfig.mealsFunded, 1);
});
