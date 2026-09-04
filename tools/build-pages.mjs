import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { money, reference, supportOptions } from "../src/catalog.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function buildPages({
  outputDir = path.join(rootDir, "dist"),
  paypalMeHandle = process.env.PAYPAL_ME_HANDLE || "Morasoom",
  fundedBaseline = process.env.QPC_MEALS_FUNDED_BASELINE || "0",
  defaultProductId = process.env.DEFAULT_PRODUCT_ID || "pirate-island"
} = {}) {
  if (!/^[A-Za-z0-9]{1,20}$/.test(paypalMeHandle)) throw new Error("PAYPAL_ME_HANDLE is invalid.");
  const mealsFunded = Number.parseInt(fundedBaseline, 10);
  if (!Number.isSafeInteger(mealsFunded) || mealsFunded < 0) throw new Error("QPC_MEALS_FUNDED_BASELINE must be a nonnegative integer.");

  const publicDir = path.join(rootDir, "public");
  const productsDir = path.join(rootDir, "data", "product-stats");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(path.join(outputDir, "assets"), { recursive: true });
  await mkdir(path.join(outputDir, "products"), { recursive: true });

  for (const file of ["index.html", "styles.css", "app.js", "embed.js"]) {
    await cp(path.join(publicDir, file), path.join(outputDir, file));
  }
  await cp(
    path.join(publicDir, "assets", "developer-dungeon-delving-ad-hero.png"),
    path.join(outputDir, "assets", "developer-dungeon-delving-ad-hero.png")
  );

  const productIds = [];
  for (const filename of (await readdir(productsDir)).filter((name) => name.endsWith(".json")).sort()) {
    const manifest = JSON.parse(await readFile(path.join(productsDir, filename), "utf8"));
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(manifest.productId || "")) throw new Error(`Invalid product manifest: ${filename}`);
    productIds.push(manifest.productId);
    await writeFile(path.join(outputDir, "products", `${manifest.productId}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (!productIds.includes(defaultProductId)) throw new Error(`DEFAULT_PRODUCT_ID has no product manifest: ${defaultProductId}`);

  const config = {
    paymentConfigured: true,
    paymentMode: "paypal_me_static",
    paypalMeHandle,
    mealsFunded,
    defaultProductId,
    productIds,
    reference,
    options: supportOptions.map((option) => ({ ...option, amount: money(option.cents) }))
  };
  await writeFile(path.join(outputDir, "static-config.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(outputDir, ".nojekyll"), "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildPages();
  console.log("GitHub Pages site built in dist/.");
}
