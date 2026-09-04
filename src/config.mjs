import path from "node:path";

export function loadConfig(env = process.env) {
  const paypalEnv = env.PAYPAL_ENV === "live" ? "live" : "sandbox";
  const publicBaseUrl = new URL(env.PUBLIC_BASE_URL || "http://localhost:8787");
  const fundedBaseline = Number.parseInt(env.QPC_MEALS_FUNDED_BASELINE || "0", 10);
  const githubRepository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || "") ? env.GITHUB_REPOSITORY : "";
  const githubRefreshMs = Number.parseInt(env.GITHUB_REFRESH_MS || "900000", 10);
  const defaultProductId = validProductId(env.DEFAULT_PRODUCT_ID) ? env.DEFAULT_PRODUCT_ID : "default";
  const supportProducts = loadSupportProducts(env.SUPPORT_PRODUCTS_JSON, defaultProductId, githubRepository);
  if (!['http:', 'https:'].includes(publicBaseUrl.protocol)) throw new Error("PUBLIC_BASE_URL must use HTTP or HTTPS.");
  return Object.freeze({
    port: Number.parseInt(env.PORT || "8787", 10),
    publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
    paypalEnv,
    paypalBaseUrl: paypalEnv === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com",
    paypalClientId: env.PAYPAL_CLIENT_ID || "",
    paypalClientSecret: env.PAYPAL_CLIENT_SECRET || "",
    paypalWebhookId: env.PAYPAL_WEBHOOK_ID || "",
    paypalMeHandle: /^[A-Za-z0-9]{1,20}$/.test(env.PAYPAL_ME_HANDLE || "Morasoom") ? (env.PAYPAL_ME_HANDLE || "Morasoom") : "",
    ledgerPath: path.resolve(env.RECEIPT_LEDGER_PATH || "./data/payment-events.jsonl"),
    productStatsDir: path.resolve(env.PRODUCT_STATS_DIR || "./data/product-stats"),
    fundedBaseline: Number.isSafeInteger(fundedBaseline) && fundedBaseline >= 0 ? fundedBaseline : 0,
    defaultProductId,
    supportProducts,
    githubRepository,
    githubToken: env.GITHUB_TOKEN || env.GH_TOKEN || "",
    githubRefreshMs: Number.isSafeInteger(githubRefreshMs) && githubRefreshMs >= 60000 ? githubRefreshMs : 900000
  });
}

function loadSupportProducts(raw, defaultProductId, legacyRepository) {
  const products = {};
  if (raw) {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("SUPPORT_PRODUCTS_JSON must be valid JSON."); }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("SUPPORT_PRODUCTS_JSON must be an object keyed by product ID.");
    for (const [productId, value] of Object.entries(parsed)) {
      if (!validProductId(productId)) throw new Error(`Invalid support product ID: ${productId}`);
      const repository = typeof value === "string" ? value : value?.githubRepository;
      if (!validRepository(repository)) throw new Error(`Invalid GitHub repository for support product: ${productId}`);
      products[productId] = Object.freeze({ githubRepository: repository });
    }
  }
  if (legacyRepository && !products[defaultProductId]) products[defaultProductId] = Object.freeze({ githubRepository: legacyRepository });
  return Object.freeze(products);
}

function validProductId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function validRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

export function paymentConfigured(config) {
  return Boolean((config.paypalClientId && config.paypalClientSecret) || config.paypalMeHandle);
}

export function paypalApiConfigured(config) {
  return Boolean(config.paypalClientId && config.paypalClientSecret);
}
