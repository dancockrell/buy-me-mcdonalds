import { money } from "./catalog.mjs";

export class PayPalClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.token = null;
  }

  async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const credentials = Buffer.from(`${this.config.paypalClientId}:${this.config.paypalClientSecret}`).toString("base64");
    const response = await this.fetch(`${this.config.paypalBaseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials"
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw providerError("PayPal authentication failed", response, data);
    this.token = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 300) * 1000 };
    return this.token.value;
  }

  async request(pathname, options = {}) {
    const token = await this.accessToken();
    const response = await this.fetch(`${this.config.paypalBaseUrl}${pathname}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json();
    if (!response.ok) throw providerError("PayPal request failed", response, data);
    return data;
  }

  async createOrder(option, requestId, productId = "default") {
    const productQuery = `product=${encodeURIComponent(productId)}`;
    return this.request("/v2/checkout/orders", {
      method: "POST",
      headers: { "PayPal-Request-Id": requestId },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          custom_id: option.id,
          description: `Voluntary support — ${option.label}`,
          amount: { currency_code: "USD", value: money(option.cents) }
        }],
        payment_source: { paypal: { experience_context: {
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: `${this.config.publicBaseUrl}/paypal/return?${productQuery}`,
          cancel_url: `${this.config.publicBaseUrl}/?${productQuery}&payment=cancelled`
        } } }
      })
    });
  }

  async captureOrder(orderId, requestId) {
    return this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST", headers: { "PayPal-Request-Id": requestId }, body: "{}"
    });
  }

  async getOrder(orderId) {
    return this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
  }

  async verifyWebhook(headers, event) {
    const required = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
    if (!this.config.paypalWebhookId || required.some((name) => !headers[name])) return false;
    const result = await this.request("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: JSON.stringify({
        auth_algo: headers["paypal-auth-algo"], cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"], transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"], webhook_id: this.config.paypalWebhookId,
        webhook_event: event
      })
    });
    return result.verification_status === "SUCCESS";
  }
}

function providerError(message, response, data) {
  const error = new Error(message);
  error.status = response.status;
  error.providerDebugId = data?.debug_id;
  error.providerName = data?.name;
  return error;
}
