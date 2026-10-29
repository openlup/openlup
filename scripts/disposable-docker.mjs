// Shared dead-owner contract. Uncertainty always retains the container.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
const standaloneRun = randomUUID();
const shortHost = () => hostname().split(".")[0];
const pidNamespace = () => process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : undefined;
export const currentRunId = () => process.env.OPENLUP_DISPOSABLE_RUN;
export function disposableLabelArgs({ run = currentRunId() ?? standaloneRun } = {}) {
  const labels = {
    "dev.disposable": "1",
    "dev.disposable.owner_pid": String(process.pid),
    "dev.disposable.owner_start": String(Math.round(Date.now() / 1000 - process.uptime())),
    "dev.disposable.host": shortHost(),
    ...(process.platform === "linux" ? { "dev.disposable.pidns": pidNamespace() } : {}),
    ...(run ? { "dev.disposable.run": run } : {}),
  };
  return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

export function parseOwnerStart(value) {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(value.trim());
  if (!match) return NaN;
  const month = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ").indexOf(match[2]);
  const [, , , day, hour, minute, second, year] = match;
  const date = new Date(Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== month || date.getUTCDate() !== Number(day)
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || date.toUTCString().slice(0, 3) !== match[1]) return NaN;
  return date.getTime() / 1000;
}
export async function ownerStart(pid, env = process.env, timeout = 10_000) {
  const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart="], {
    env: { ...env, LC_ALL: "C", TZ: "UTC" }, timeout, killSignal: "SIGKILL",
  });
  return parseOwnerStart(stdout);
}

export function classify(container, probe, now, { minAgeSeconds = 60 } = {}) {
  const keep = reason => ({ decision: "keep", reason });
  try {
    const labels = container.Config?.Labels;
    if (labels?.["dev.disposable"] !== "1") return keep("not_disposable");
    // Parity with the shared shell reaper: Supabase CLI stacks stay a reviewed manual removal.
    if (labels["com.supabase.cli.project"] !== undefined) return keep("supabase_project");
    if (labels["dev.disposable.host"] !== probe.hostname()) return keep("host_mismatch");
    if (probe.platform === "linux" && (!labels["dev.disposable.pidns"] || labels["dev.disposable.pidns"] !== probe.pidns())) return keep("pidns_mismatch_or_missing");
    const created = typeof container.Created === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(container.Created) ? Date.parse(container.Created) / 1000 : NaN;
    if (!Number.isFinite(created) || new Date(created * 1000).toISOString().slice(0, 19) !== container.Created.slice(0, 19) || !Number.isFinite(now)) return keep("created_unparsable");
    if (now - created < minAgeSeconds) return keep("too_young");
    const pid = labels["dev.disposable.owner_pid"];
    if (!/^[1-9]\d{0,8}$/u.test(pid ?? "") || Number(pid) <= 1) return keep("owner_pid_malformed");
    try { probe.kill(Number(pid), 0); } catch (error) {
      return error.code === "ESRCH" ? { decision: "dead", reason: "owner_gone" } : keep("owner_probe_refused");
    }
    const start = labels["dev.disposable.owner_start"];
    if (!/^[1-9]\d*$/u.test(start ?? "") || !Number.isSafeInteger(Number(start))) return keep("owner_start_missing_or_malformed");
    const current = parseOwnerStart(probe.ps(Number(pid)));
    if (!Number.isFinite(current)) return keep("owner_start_unreadable");
    return Math.abs(current - Number(start)) > 2 ? { decision: "dead", reason: "owner_pid_recycled" } : keep("owner_alive");
  } catch { return keep("probe_failed"); }
}

export async function sweep({ mode = "report", selector, docker = "docker", minAgeSeconds = 60, budgetMs = 60_000 } = {}) {
  const decisions = [];
  const deadline = performance.now() + Math.max(1, Math.min(60_000, budgetMs));
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now());
    if (ms <= 0) throw new Error("sweep_budget_exhausted");
    return Math.min(10_000, ms);
  };
  const log = item => { decisions.push(item); console.error(`docker-reap: ${item.action ?? item.decision} ${item.id ?? "daemon"} reason=${item.reason}`); };
  const call = async args => (await exec(docker, args, { timeout: remaining(), killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 })).stdout;
  try {
    if (!["report", "remove"].includes(mode) || (selector !== undefined && !/^[^=\s]+=\S+$/u.test(selector))) throw new Error("invalid_sweep_options");
    const output = await call(["ps", "-a", "-q", "--no-trunc", "--filter", "label=dev.disposable=1", ...(selector ? ["--filter", `label=${selector}`] : [])]);
    const ids = output.trim().split(/\s+/u).filter(Boolean);
    for (const id of ids) {
      if (!/^[a-f0-9]{64}$/u.test(id)) { log({ decision: "keep", reason: "invalid_list_id" }); continue; }
      try {
        const info = JSON.parse(await call(["inspect", id]));
        const container = Array.isArray(info) && info.length === 1 ? info[0] : undefined;
        if (container?.Id !== id) throw new Error("inspect_identity_mismatch");
        // Check the selector again after inspect, rather than trusting list output.
        if (selector) {
          const split = selector.indexOf("=");
          if (container.Config?.Labels?.[selector.slice(0, split)] !== selector.slice(split + 1)) { log({ id, decision: "keep", reason: "selector_mismatch" }); continue; }
        }
        const pid = container.Config?.Labels?.["dev.disposable.owner_pid"];
        let killError, started = "";
        if (/^[1-9]\d{0,8}$/u.test(pid ?? "") && Number(pid) > 1) {
          try { process.kill(Number(pid), 0); } catch (error) { killError = error; }
          if (!killError) {
            try { started = (await exec("ps", ["-p", pid, "-o", "lstart="], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: remaining(), killSignal: "SIGKILL" })).stdout; } catch { /* Unreadable start keeps. */ }
          }
        }
        const verdict = classify(container, { platform: process.platform, hostname: shortHost, pidns: pidNamespace,
          kill: () => { if (killError) throw killError; }, ps: () => started }, Date.now() / 1000, { minAgeSeconds });
        const item = { id, ...verdict, action: verdict.decision === "dead" ? "would_remove" : "keep" };
        if (verdict.decision === "dead" && mode === "remove") {
          try { await call(["rm", "-f", "-v", container.Id]); item.action = "removed"; }
          catch { item.action = "keep"; item.reason = "docker_remove_failed_or_timeout"; }
        }
        log(item);
      } catch { log({ id, decision: "keep", reason: "docker_inspect_failed_or_timeout" }); }
      if (performance.now() >= deadline) break;
    }
  } catch (error) { log({ decision: "keep", reason: `docker_unavailable_or_timeout: ${error.code ?? error.message}` }); }
  return decisions;
}
