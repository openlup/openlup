// Run trusted main's copy; candidate commits are read as objects, never executed.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { admit, carryOver, demand, RECEIPT_MARKER } from './agent-review-decide.mjs';
import { captureCommittedReviewCandidate, git } from './agent-review-session.mjs';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
export function parseReceipt(body) {
  if (typeof body !== 'string' || body.length > 1024 * 1024 || !body.startsWith(`${RECEIPT_MARKER}\n`)) return null;
  const match = /^```json\s*\n([\s\S]*?)\n```\s*$/u.exec(body.slice(RECEIPT_MARKER.length + 1));
  try { return match ? JSON.parse(match[1]) : null; } catch { return null; }
}
export async function readReceipts(api, root, pr, head, now, permissions = new Map()) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await api.get(`${root}/issues/${pr}/comments?per_page=100&page=${page}`);
    demand(Array.isArray(batch), 'PR comments response is invalid'); comments.push(...batch);
    if (batch.length < 100) break;
  }
  const receipts = [];
  comments.sort((a, b) => Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at) || b.id - a.id);
  for (const comment of comments) {
    const receipt = parseReceipt(comment.body); const login = comment.user?.login;
    if (receipt?.pr !== pr || receipt.head !== head || !admit({ receipt, observed: { ...receipt, baseValid: true }, now }).ok || comment.user?.type !== 'User' || typeof login !== 'string' || !login) continue;
    const key = login.toLowerCase();
    if (!permissions.has(key)) {
      try {
        const access = await api.get(`${root}/collaborators/${encodeURIComponent(login)}/permission`);
        // The base permission covers custom roles; use role_name only when absent.
        permissions.set(key, ['admin', 'maintain', 'write'].includes(access?.permission ?? access?.role_name));
      } catch { /* A failed lookup never establishes trust; the next poll asks again. */ }
    }
    if (permissions.get(key)) receipts.push(receipt);
  }
  return receipts;
}
async function ancestor(runGit, cwd, base, head) {
  try { await runGit(cwd, 'merge-base', '--is-ancestor', base, head); return true; } catch { return false; }
}
export async function carryOverSourceReview(cwd, candidate, group, runGit = git) {
  const baseAncestor = await ancestor(runGit, cwd, candidate.base, group.base);
  let predictedTree; let movedPaths = [];
  if (baseAncestor && candidate.tree !== group.tree) {
    try { predictedTree = (await runGit(cwd, 'merge-tree', '--write-tree', `--merge-base=${candidate.base}`, group.base, candidate.head)).trim(); } catch { predictedTree = null; }
    movedPaths = (await runGit(cwd, 'diff', '--name-only', '--no-renames', '-z', candidate.base, group.base)).split('\0').filter(Boolean);
  }
  return carryOver({ reviewedTree: candidate.tree, groupTree: group.tree, baseAncestor, predictedTree, changedPaths: candidate.changedPaths, movedPaths });
}
export async function waitNativeAdmission({ event, env = process.env, api, cwd = process.cwd(), now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), deadlineMs = 20 * 60 * 1000, runGit = git }) {
  demand(/^[\w.-]+\/[\w.-]+$/u.test(env.GITHUB_REPOSITORY ?? '') && event.repository?.private === false, 'use a public repository GitHub event');
  const root = `/repos/${env.GITHUB_REPOSITORY}`; const group = env.GITHUB_EVENT_NAME === 'merge_group' ? event.merge_group : null;
  demand(['pull_request', 'merge_group'].includes(env.GITHUB_EVENT_NAME), 'only pull_request and merge_group events are supported');
  const match = group && /^(?:refs\/heads\/)?gh-readonly-queue\/main\/pr-(\d+)-[a-f0-9]+$/u.exec(group.head_ref ?? '');
  const prNumber = group ? Number(match?.[1]) : event.number;
  demand(Number.isSafeInteger(prNumber) && prNumber > 0, 'event must name one PR on main');
  if (group) demand(event.action === 'checks_requested' && group.base_ref === 'refs/heads/main' && SHA.test(group.head_sha) && SHA.test(group.base_sha) && (!env.GITHUB_SHA || env.GITHUB_SHA === group.head_sha) && (!env.GITHUB_REF || env.GITHUB_REF === group.head_ref), 'merge group identity differs from the event');
  const permissions = new Map();
  const start = now(); let reason = 'post a current receipt comment from a user with write, maintain or admin permission';
  while (now() - start < deadlineMs) {
    const pr = await api.get(`${root}/pulls/${prNumber}`);
    demand(pr.number === prNumber && pr.state === 'open' && pr.draft === false && !pr.merged && pr.base?.ref === 'main' && SHA.test(pr.head?.sha), 'PR must be the live open main candidate');
    if (!group) demand(event.pull_request?.head?.sha === pr.head.sha, 'PR head changed; rerun CI for the current head', 'stale');
    const receipts = await readReceipts(api, root, prNumber, pr.head.sha, now(), permissions);
    for (const receipt of receipts) {
      const main = (await api.get(`${root}/git/ref/heads/main`)).object?.sha; demand(SHA.test(main), 'main commit identity is invalid');
      const refs = [...new Set([receipt.base, receipt.head, main, ...(group ? [group.base_sha, group.head_sha] : [])])];
      let candidate; let baseValid;
      try {
        await runGit(cwd, '-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', ...refs);
        await runGit(cwd, 'update-ref', 'refs/remotes/origin/main', main);
        candidate = await captureCommittedReviewCandidate(cwd, receipt.base, receipt.head, runGit);
        const forks = (await runGit(cwd, 'merge-base', '--all', receipt.head, 'origin/main')).trim().split('\n');
        baseValid = forks.length === 1 && SHA.test(forks[0]) && receipt.base === forks[0];
      } catch (error) { reason = `receipt objects could not be verified: ${error.message}; post a corrected receipt`; continue; }
      let decision = admit({ receipt, observed: { ...candidate, pr: prNumber, baseValid }, now: now() });
      if (!decision.ok) { reason = `${decision.code}: ${decision.reason}`; continue; }
      if (group) {
        const tree = (await runGit(cwd, 'rev-parse', '--verify', `${group.head_sha}^{tree}`)).trim();
        decision = await carryOverSourceReview(cwd, candidate, { base: group.base_sha, tree }, runGit);
        demand(decision.ok, decision.reason, decision.code);
      }
      const live = await api.get(`${root}/pulls/${prNumber}`);
      demand(live.head?.sha === pr.head.sha && live.state === 'open' && live.draft === false && !live.merged && live.base?.ref === 'main', 'PR changed during admission; rerun CI', 'stale');
      demand((await api.get(`${root}/git/ref/heads/main`)).object?.sha === main, 'main moved during admission; rerun CI', 'stale');
      const final = admit({ receipt, observed: { ...candidate, pr: prNumber, baseValid }, now: now() }); demand(final.ok, final.reason, final.code);
      console.log(`Native review admission verified: ${group ? decision.reason : 'reviewed PR head'}.`); return;
    }
    console.log(`needs_agent_review: ${reason}`); await sleep(Math.min(15000, Math.max(0, deadlineMs - (now() - start))));
  }
  throw new Error(`needs_agent_review: bounded 20-minute receipt wait expired; ${reason}`);
}
async function main() {
  demand(process.argv[2] === 'wait' && process.argv.length === 3, 'use wait');
  const api = { get: async path => JSON.parse((await execute('gh', ['api', path], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout) };
  await waitNativeAdmission({ event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')), api });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(error => { console.error(error.message); process.exitCode = 1; });
