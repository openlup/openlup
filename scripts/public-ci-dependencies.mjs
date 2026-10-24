/** Admission uses GitHub's dependency diff; publication separately audits the full selected graph. */
import { readFileSync } from "node:fs";
import { env } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sha = /^[a-f0-9]{40}$/;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function dependencyRange(eventName, event) {
  const [base, head] = eventName === "pull_request"
    ? [event.pull_request?.base?.sha, event.pull_request?.head?.sha]
    : eventName === "merge_group"
      ? [event.merge_group?.base_sha, event.merge_group?.head_sha]
      : eventName === "push" ? [event.before, event.after] : [];
  if (!sha.test(base ?? "") || !sha.test(head ?? "") || /^0+$/.test(base) || base === head) {
    throw new Error("dependency review requires the event's distinct full base/head SHAs");
  }
  return { base, head };
}

export async function reviewDependencies({ repository, base, head, token, fetch: request = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !token || !sha.test(base) || !sha.test(head)) {
    throw new Error("dependency review requires repository, token and exact commit identities");
  }
  const endpoint = `https://api.github.com/repos/${repository}/dependency-graph/compare/${base}...${head}`;
  const seen = new Set();
  const violations = [];
  let url = `${endpoint}?per_page=100`;
  while (url) {
    const next = new URL(url);
    if (next.origin !== "https://api.github.com" || next.pathname !== new URL(endpoint).pathname || seen.has(url)) {
      throw new Error("dependency review returned an invalid pagination link");
    }
    seen.add(url);
    const response = await request(url, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`dependency review unavailable: HTTP ${response.status}`);
    if (response.headers.get("x-github-dependency-graph-snapshot-warnings")?.trim()) {
      throw new Error("dependency review has incomplete snapshots; no passing security verdict");
    }
    const changes = await response.json();
    if (!Array.isArray(changes)) throw new Error("dependency review returned no change array");
    for (const change of changes) {
      if (!record(change) || !["added", "removed"].includes(change.change_type) ||
          !["manifest", "name", "version"].every((key) => typeof change[key] === "string" && change[key]) ||
          !Array.isArray(change.vulnerabilities) ||
          (change.scope !== undefined && !["runtime", "development", "unknown"].includes(change.scope))) {
        throw new Error("dependency review returned an incomplete dependency change");
      }
      if (change.change_type !== "added" || change.scope === "development") continue;
      for (const advisory of change.vulnerabilities) {
        if (!record(advisory) || !["low", "moderate", "high", "critical"].includes(advisory.severity) ||
            typeof advisory.advisory_ghsa_id !== "string") throw new Error("dependency review returned incomplete vulnerability data");
        violations.push(`${change.manifest}: ${change.name}@${change.version} ${advisory.advisory_ghsa_id} (${advisory.severity})`);
      }
    }
    const link = response.headers.get("link") ?? "";
    url = "";
    for (const part of link ? link.split(",") : []) {
      const parsed = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
      if (!parsed || (parsed[2] === "next" && url)) throw new Error("dependency review returned malformed pagination");
      if (parsed[2] === "next") url = parsed[1];
    }
  }
  if (violations.length) throw new Error(`new vulnerable production dependencies:\n${violations.join("\n")}`);
  return `dependency review passed for ${base}...${head}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const range = dependencyRange(env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")));
    console.log(await reviewDependencies({ repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN, ...range }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
