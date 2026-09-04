import { readFile } from "node:fs/promises";
import path from "node:path";

const REST_API = "https://api.github.com";
const GRAPHQL_API = "https://api.github.com/graphql";

const REPOSITORY_TOTALS_QUERY = `
  query RepositoryTotals($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      defaultBranchRef {
        name
        target {
          ... on Commit {
            history { totalCount }
          }
        }
      }
      pullRequests { totalCount }
      latestRelease { tagName publishedAt url }
    }
  }
`;

export class GitHubUpdateClient {
  constructor(config, fetchImpl = fetch) {
    this.repository = config.githubRepository;
    this.token = config.githubToken;
    this.refreshMs = config.githubRefreshMs;
    this.fetch = fetchImpl;
    this.cached = null;
    this.pending = null;
  }

  async check({ force = false } = {}) {
    if (!this.repository) return null;
    if (!force && this.cached && Date.now() - this.cached.cachedAt < this.refreshMs) return this.cached.value;
    if (this.pending) return this.pending;

    this.pending = this.fetchSnapshot().then((value) => {
      this.cached = { cachedAt: Date.now(), value };
      return value;
    }).catch((error) => {
      if (!this.cached) throw error;
      return Object.freeze({ ...this.cached.value, stale: true, refreshError: publicError(error) });
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async fetchSnapshot() {
    try {
      return this.token ? await this.fetchGraphqlSnapshot() : await this.fetchRestSnapshot();
    } catch (error) {
      if (error?.service === "github") throw error;
      const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
      throw githubError(`GitHub update request could not be completed.${detail}`, 502);
    }
  }

  async fetchGraphqlSnapshot() {
    const [owner, name] = this.repository.split("/");
    const response = await this.fetch(GRAPHQL_API, {
      method: "POST",
      headers: this.headers({ json: true }),
      body: JSON.stringify({ query: REPOSITORY_TOTALS_QUERY, variables: { owner, name } })
    });
    const payload = await requiredJson(response, "repository totals");
    if (payload.errors?.length) throw githubError(payload.errors[0]?.message || "GitHub rejected the repository totals query.", 502);
    if (!payload.data?.repository) throw githubError("GitHub repository was not found or is not accessible to this token.", 404);

    const repository = payload.data.repository;
    const commitCount = repository.defaultBranchRef?.target?.history?.totalCount;
    const pullRequestCount = repository.pullRequests?.totalCount;
    if (!Number.isSafeInteger(commitCount) || !Number.isSafeInteger(pullRequestCount)) {
      throw githubError("GitHub returned incomplete repository totals.", 502);
    }

    return snapshot({
      repository: repository.nameWithOwner || this.repository,
      source: "github_graphql",
      defaultBranch: repository.defaultBranchRef?.name || null,
      commitCount,
      pullRequestCount,
      latestRelease: normalizeRelease(repository.latestRelease)
    });
  }

  async fetchRestSnapshot() {
    const encodedRepo = this.repository.split("/").map(encodeURIComponent).join("/");
    const headers = this.headers();
    const [repositoryResponse, releaseResponse, commitsResponse, pullsResponse] = await Promise.all([
      this.fetch(`${REST_API}/repos/${encodedRepo}`, { headers }),
      this.fetch(`${REST_API}/repos/${encodedRepo}/releases/latest`, { headers }),
      this.fetch(`${REST_API}/repos/${encodedRepo}/commits?per_page=1`, { headers }),
      this.fetch(`${REST_API}/repos/${encodedRepo}/pulls?state=all&per_page=1`, { headers })
    ]);

    const repositoryData = await requiredJson(repositoryResponse, "repository");
    const commitItems = await requiredJson(commitsResponse, "commits");
    const pullItems = await requiredJson(pullsResponse, "pull requests");
    const releaseData = releaseResponse.status === 404 ? null : await requiredJson(releaseResponse, "latest release");

    return snapshot({
      repository: repositoryData.full_name || this.repository,
      source: "github_rest",
      defaultBranch: repositoryData.default_branch || null,
      commitCount: collectionCount(commitsResponse.headers.get("link"), commitItems),
      pullRequestCount: collectionCount(pullsResponse.headers.get("link"), pullItems),
      latestRelease: normalizeRelease(releaseData)
    });
  }

  headers({ json = false } = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "independent-software-support-applet",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (json) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }
}

export class GitHubUpdateRegistry {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.clients = new Map();
  }

  async check(productId, options = {}) {
    const repository = this.config.supportProducts[productId]?.githubRepository;
    if (!repository) return null;
    const manifest = await this.readManifest(productId, repository);
    if (manifest && !this.config.githubToken) return manifest;
    if (!this.clients.has(productId)) {
      this.clients.set(productId, new GitHubUpdateClient({
        githubRepository: repository,
        githubToken: this.config.githubToken,
        githubRefreshMs: this.config.githubRefreshMs
      }, this.fetch));
    }
    try {
      return await this.clients.get(productId).check(options);
    } catch (error) {
      if (manifest) return manifest;
      throw error;
    }
  }

  async readManifest(productId, repository) {
    if (!this.config.productStatsDir) return null;
    try {
      const body = await readFile(path.join(this.config.productStatsDir, `${productId}.json`), "utf8");
      return validateProductStats(JSON.parse(body), productId, repository);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw githubError(`The stored GitHub statistics for ${productId} are invalid.`, 502);
    }
  }
}

export function validateProductStats(value, productId, repository) {
  if (!value || value.productId !== productId || value.repository !== repository) throw new Error("Product statistics identity mismatch.");
  if (!Number.isSafeInteger(value.commitCount) || value.commitCount < 0) throw new Error("Invalid product commit count.");
  if (!Number.isSafeInteger(value.pullRequestCount) || value.pullRequestCount < 0) throw new Error("Invalid product pull-request count.");
  if (!value.checkedAt || Number.isNaN(Date.parse(value.checkedAt))) throw new Error("Invalid product statistics timestamp.");
  return Object.freeze({
    productId,
    repository,
    checkedAt: value.checkedAt,
    source: "release_manifest",
    stale: false,
    defaultBranch: value.defaultBranch || null,
    commitCount: value.commitCount,
    pullRequestCount: value.pullRequestCount,
    latestRelease: value.latestRelease || null
  });
}

function snapshot(value) {
  return Object.freeze({ checkedAt: new Date().toISOString(), stale: false, ...value });
}

function normalizeRelease(release) {
  if (!release) return null;
  return Object.freeze({
    tagName: release.tagName ?? release.tag_name ?? null,
    publishedAt: release.publishedAt ?? release.published_at ?? null,
    url: release.url ?? release.html_url ?? null
  });
}

async function requiredJson(response, label) {
  let payload;
  try { payload = await response.json(); }
  catch { throw githubError(`GitHub ${label} request returned an unreadable response.`, 502); }
  if (!response.ok) {
    const message = typeof payload?.message === "string" ? ` ${payload.message}` : "";
    throw githubError(`GitHub ${label} request failed with ${response.status}.${message}`, response.status);
  }
  return payload;
}

function githubError(message, status) {
  const error = new Error(message);
  error.status = status;
  error.service = "github";
  return error;
}

function publicError(error) {
  return error instanceof Error ? error.message : "GitHub refresh failed.";
}

export function collectionCount(linkHeader, items) {
  const last = String(linkHeader || "").match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  if (last) return Number.parseInt(last[1], 10);
  return Array.isArray(items) ? items.length : 0;
}
