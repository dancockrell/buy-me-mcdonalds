import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPages } from "../tools/build-pages.mjs";

test("GitHub Pages build is a self-contained PayPal.Me site", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "support-pages-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  await buildPages({ outputDir, paypalMeHandle: "Morasoom", fundedBaseline: "3", defaultProductId: "pirate-island" });

  const index = await readFile(path.join(outputDir, "index.html"), "utf8");
  assert.match(index, /href="\.\/styles\.css"/);
  assert.match(index, /src="\.\/app\.js"/);

  const config = JSON.parse(await readFile(path.join(outputDir, "static-config.json"), "utf8"));
  assert.equal(config.paymentMode, "paypal_me_static");
  assert.equal(config.paypalMeHandle, "Morasoom");
  assert.equal(config.mealsFunded, 3);
  assert.equal(config.options.length, 5);
  assert.equal(config.options.at(-1).amount, "12.19");

  const product = JSON.parse(await readFile(path.join(outputDir, "products", "pirate-island.json"), "utf8"));
  assert.equal(product.productId, "pirate-island");
  assert.equal(product.commitCount, 74);
  assert.equal(product.pullRequestCount, 4);
});
