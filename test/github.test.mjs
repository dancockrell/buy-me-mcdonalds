import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitHubUpdateClient, GitHubUpdateRegistry, collectionCount } from "../src/github.mjs";

test("GitHub update check returns release, commit, and pull-request totals", async () => {
  const responses = new Map([
    ["/repos/owner/game", new Response(JSON.stringify({ full_name: "owner/game", default_branch: "main" }))],
    ["/releases/latest", new Response(JSON.stringify({ tag_name: "v1.4.0", published_at: "2026-09-04T00:00:00Z", html_url: "https://github.com/owner/game/releases/tag/v1.4.0" }))],
    ["/commits?per_page=1", new Response(JSON.stringify([{ sha: "abc" }]), { headers: { Link: '<https://api.github.com/repositories/1/commits?per_page=1&page=2481>; rel="last"' } })],
    ["/pulls?state=all&per_page=1", new Response(JSON.stringify([{ number: 193 }]), { headers: { Link: '<https://api.github.com/repositories/1/pulls?state=all&per_page=1&page=193>; rel="last"' } })]
  ]);
  const fetchImpl = async (url) => {
    const entry = [...responses.entries()].find(([suffix]) => url.endsWith(suffix));
    assert.ok(entry, `unexpected URL: ${url}`);
    return entry[1];
  };
  const client = new GitHubUpdateClient({ githubRepository: "owner/game", githubToken: "", githubRefreshMs: 900000 }, fetchImpl);
  const snapshot = await client.check();
  assert.equal(snapshot.commitCount, 2481);
  assert.equal(snapshot.pullRequestCount, 193);
  assert.equal(snapshot.defaultBranch, "main");
  assert.equal(snapshot.source, "github_rest");
  assert.equal(snapshot.latestRelease.tagName, "v1.4.0");
});

test("authenticated GitHub update check uses exact GraphQL totals", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      data: {
        repository: {
          nameWithOwner: "owner/private-game",
          defaultBranchRef: { name: "main", target: { history: { totalCount: 87 } } },
          pullRequests: { totalCount: 14 },
          latestRelease: { tagName: "v0.3.0", publishedAt: "2026-09-04T00:00:00Z", url: "https://github.com/owner/private-game/releases/tag/v0.3.0" }
        }
      }
    }));
  };
  const client = new GitHubUpdateClient({ githubRepository: "owner/private-game", githubToken: "private-token", githubRefreshMs: 900000 }, fetchImpl);
  const snapshot = await client.check({ force: true });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-token");
  assert.deepEqual(JSON.parse(calls[0].options.body).variables, { owner: "owner", name: "private-game" });
  assert.equal(snapshot.commitCount, 87);
  assert.equal(snapshot.pullRequestCount, 14);
  assert.equal(snapshot.source, "github_graphql");
  assert.equal(snapshot.stale, false);
});

test("a failed refresh preserves the last confirmed GitHub totals", async () => {
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error("network unavailable");
    return new Response(JSON.stringify({ data: { repository: {
      nameWithOwner: "owner/game",
      defaultBranchRef: { name: "main", target: { history: { totalCount: 10 } } },
      pullRequests: { totalCount: 3 },
      latestRelease: null
    } } }));
  };
  const client = new GitHubUpdateClient({ githubRepository: "owner/game", githubToken: "token", githubRefreshMs: 900000 }, fetchImpl);
  await client.check();
  fail = true;
  const snapshot = await client.check({ force: true });
  assert.equal(snapshot.commitCount, 10);
  assert.equal(snapshot.pullRequestCount, 3);
  assert.equal(snapshot.stale, true);
  assert.match(snapshot.refreshError, /network unavailable/);
});

test("the GitHub registry isolates repositories and caches by product", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const { variables } = JSON.parse(options.body);
    calls.push(variables.name);
    const count = variables.name === "pirate-game" ? 87 : 203;
    return new Response(JSON.stringify({ data: { repository: {
      nameWithOwner: `${variables.owner}/${variables.name}`,
      defaultBranchRef: { name: "main", target: { history: { totalCount: count } } },
      pullRequests: { totalCount: count === 87 ? 14 : 31 },
      latestRelease: null
    } } }));
  };
  const registry = new GitHubUpdateRegistry({
    supportProducts: {
      "pirate-island": { githubRepository: "owner/pirate-game" },
      "book-reader": { githubRepository: "owner/book-reader" }
    },
    githubToken: "token",
    githubRefreshMs: 900000
  }, fetchImpl);

  assert.equal((await registry.check("pirate-island")).commitCount, 87);
  assert.equal((await registry.check("book-reader")).commitCount, 203);
  assert.equal((await registry.check("pirate-island")).commitCount, 87);
  assert.deepEqual(calls, ["pirate-game", "book-reader"]);
  assert.equal(await registry.check("unknown"), null);
});

test("a product release manifest supplies totals without runtime GitHub access", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "support-product-stats-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(temp, { recursive: true });
  await writeFile(path.join(temp, "pirate-island.json"), JSON.stringify({
    productId: "pirate-island",
    repository: "owner/pirate-game",
    defaultBranch: "main",
    commitCount: 74,
    pullRequestCount: 4,
    checkedAt: "2026-09-04T00:00:00Z",
    latestRelease: null
  }));
  let networkCalls = 0;
  const registry = new GitHubUpdateRegistry({
    supportProducts: { "pirate-island": { githubRepository: "owner/pirate-game" } },
    githubToken: "",
    githubRefreshMs: 900000,
    productStatsDir: temp
  }, async () => { networkCalls += 1; throw new Error("network must not be used"); });

  const snapshot = await registry.check("pirate-island", { force: true });
  assert.equal(networkCalls, 0);
  assert.equal(snapshot.source, "release_manifest");
  assert.equal(snapshot.commitCount, 74);
  assert.equal(snapshot.pullRequestCount, 4);
});

test("collection count handles zero and single-page repositories", () => {
  assert.equal(collectionCount(null, []), 0);
  assert.equal(collectionCount(null, [{ id: 1 }]), 1);
});
