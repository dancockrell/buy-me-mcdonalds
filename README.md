# Buy Me McDonald’s

A shared support page and PayPal backend for independent software. Every product supplies its own work totals while confirmed meal funding remains shared. The interface offers a five-item food-price scale and never treats a checkout handoff as proof of payment.

## What works now

- The default payment destination is `https://paypal.me/Morasoom`.
- The five server-owned amounts are $0.05, $2.31, $2.89, $6.19, and $12.19 USD. The browser cannot substitute another amount.
- PayPal.Me requests include the exact amount and `USD`, for example `https://paypal.me/Morasoom/12.19USD`.
- Each handoff is recorded without an IP address, email, precise location, or product usage facts.
- If PayPal REST credentials are configured, the same applet creates and captures Orders v2 on the server and records provider order and capture IDs.
- Signed PayPal webhooks can be verified by PayPal's verification endpoint and are stored idempotently.
- The page adds one Quarter Pounder meal for each unique confirmed payment of at least $12.19. Smaller choices add zero. Set `QPC_MEALS_FUNDED_BASELINE` to a verified nonnegative historical count from before this ledger began.
- Each product ID is mapped server-side to its own GitHub repository. The product-specific `/api/update-check` response supplies the latest release, exact default-branch commit count, and exact all-time pull-request count. Authenticated checks use GitHub GraphQL totals in one request; public repositories can use the REST fallback. Results are cached separately per product for 15 minutes by default.

PayPal.Me does not provide this backend with independent completion confirmation. In that mode, the applet says only that PayPal was opened. Use the REST application mode when automatic paid-status reconciliation is required.

## Run

Requires Node.js 20 or newer and has no third-party package dependencies.

```powershell
$env:PAYPAL_ME_HANDLE = "Morasoom"
npm start
```

Open `http://localhost:8787`.

Configure the allowlisted products and their repositories:

```text
DEFAULT_PRODUCT_ID=pirate-island
SUPPORT_PRODUCTS_JSON={"pirate-island":"dancockrell/project-42-pirate-island-rpg"}
PRODUCT_STATS_DIR=./data/product-stats
GITHUB_TOKEN=optional_live_refresh_only
GITHUB_REFRESH_MS=900000
```

`GET /api/update-check?product=pirate-island` returns that product's release and repository totals. `GET /api/config?product=pirate-island` supplies the same snapshot to the support page. Unknown product IDs are rejected; clients cannot ask the server to query arbitrary repositories. The older `GITHUB_REPOSITORY` setting remains as a single-product fallback.

## No-login product statistics

Runtime applications do not log into GitHub. Each product build generates a small statistics manifest while it is already running inside GitHub Actions, where GitHub supplies the workflow's repository token automatically:

```powershell
npm run stats:generate -- --product pirate-island --repository dancockrell/project-42-pirate-island-rpg --output data/product-stats/pirate-island.json
```

The generated file contains the product ID, repository, default branch, exact commit count, exact all-time pull-request count, retrieval time, and latest release. Ship that file with the product's update data or copy it into the support service's `PRODUCT_STATS_DIR`. With a manifest present and no runtime token, the support server reads the file directly and makes no GitHub request. A malformed manifest or a repository/product mismatch is rejected.

`GITHUB_TOKEN` or `GH_TOKEN` remains supported for an optional server-side live refresh, but it is not required by an installed application and is never sent to the browser.

The server reads environment variables directly; `.env.example` is an operator template. In a production host, configure the variables in that host's secret/settings interface.

## Enable confirmed PayPal capture

Create a PayPal REST application and set:

```text
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...
PUBLIC_BASE_URL=https://your-public-support-domain.example
```

Test in `sandbox`, register `https://your-public-support-domain.example/api/webhooks/paypal` for payment events, and move to `PAYPAL_ENV=live` only after the sandbox flow succeeds. Never put the client secret in the browser or a distributed game.

## Use the update check in a product

The update response already contains the exact work totals. Pass that same response into the support page instead of maintaining a second counter:

```html
<script src="https://your-support-domain.example/embed.js"></script>
<button id="support">Support this work</button>
<script>
  let updateSnapshot;

  async function checkForUpdates() {
    updateSnapshot = await fetch("https://your-support-domain.example/api/update-check?product=pirate-island&force=1")
      .then((response) => {
        if (!response.ok) throw new Error("Update check failed");
        return response.json();
      });
    return updateSnapshot;
  }

  document.querySelector("#support").addEventListener("click", () => {
    IndependentSupport.open({ productId: "pirate-island", updateSnapshot });
  });
</script>
```

For a desktop web view or an existing iframe, send the response after the page loads:

```js
supportFrame.contentWindow.postMessage({
  type: "independent-support-facts",
  productId: "pirate-island",
  updateSnapshot
}, supportAppletOrigin);
```

The values are rendered locally and are not included in order creation or the payment ledger.

## Verify

```powershell
npm test
npm run check
```

The dated pricing evidence and operating documents are in `outputs/`.

## License

[MIT](LICENSE)
