import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitHubUpdateClient } from "../src/github.mjs";

const args = parseArgs(process.argv.slice(2));
const productId = args.product || process.env.SUPPORT_PRODUCT_ID;
const repository = args.repository || process.env.GITHUB_REPOSITORY;
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(productId || "")) throw new Error("A valid --product is required.");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) throw new Error("A valid --repository owner/name is required.");

const client = new GitHubUpdateClient({
  githubRepository: repository,
  githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  githubRefreshMs: 60_000
});
const snapshot = await client.check({ force: true });
const outputPath = path.resolve(args.output || path.join("data", "product-stats", `${productId}.json`));
const manifest = {
  productId,
  repository: snapshot.repository,
  defaultBranch: snapshot.defaultBranch,
  commitCount: snapshot.commitCount,
  pullRequestCount: snapshot.pullRequestCount,
  checkedAt: snapshot.checkedAt,
  latestRelease: snapshot.latestRelease
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote ${manifest.commitCount} commits and ${manifest.pullRequestCount} pull requests to ${outputPath}`);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    if (!key || value === undefined) throw new Error("Arguments must be --name value pairs.");
    result[key] = value;
  }
  return result;
}
