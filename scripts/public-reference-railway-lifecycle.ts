import { execFileSync } from "node:child_process";

export type RailwayCommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number };
export type RailwayCommand = (file: string, args: string[], options?: RailwayCommandOptions) => string;
export type RailwayClock = () => number;
export type RailwaySleep = (milliseconds: number) => Promise<void>;
export type RailwayProjectCleanup = { disposition: "absent" | "provider-scheduled-purge"; deletionScheduledAt: string | null; projectActive: false; retainedServiceIds: string[]; activeDeploymentCount: 0 };
export type RailwayRuntimeTarget = { environmentId: string; serviceId?: string };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;
const COMMAND_SLICE_MS = 10 * 60_000;
const CLEANUP_SLICE_MS = 30_000;
const POLL_MS = 2_000;

export const systemRailwayCommand: RailwayCommand = (file, args, options = {}) => execFileSync(file, args, {
  cwd: options.cwd,
  env: options.env,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 32 * 1024 * 1024,
  timeout: options.timeout,
  killSignal: "SIGKILL",
}).trim();

export function remainingRailwayTime(deadline: number, now: RailwayClock, label: string) {
  const remaining = deadline - now();
  if (!Number.isFinite(deadline) || !Number.isFinite(remaining) || remaining <= 0) throw new Error(`public Railway receipt refused: ${label} deadline elapsed; cleanup is required`);
  return remaining;
}

export function boundedRailwayCommand(command: RailwayCommand, deadline: number, now: RailwayClock, maximum = COMMAND_SLICE_MS): RailwayCommand {
  return (file, args, options = {}) => command(file, args, {
    ...options,
    timeout: Math.max(1, Math.min(options.timeout ?? maximum, remainingRailwayTime(deadline, now, "provider operation"))),
  });
}

export async function boundedRailwayFetch(fetcher: typeof fetch, input: string, init: RequestInit | undefined, deadline: number, now: RailwayClock) {
  const timeout = Math.max(1, Math.min(10_000, remainingRailwayTime(deadline, now, "provider HTTP")));
  return fetcher(input, { ...init, signal: AbortSignal.timeout(timeout) });
}

export async function boundedRailwaySleep(milliseconds: number, deadline: number, now: RailwayClock, sleep: RailwaySleep) {
  await sleep(Math.min(milliseconds, remainingRailwayTime(deadline, now, "provider poll")));
}

function idsFromJson(raw: string, label: string) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`public Railway receipt refused: ${label} did not return JSON`); }
  if (!Array.isArray(value)) throw new Error(`public Railway receipt refused: ${label} did not return a JSON list`);
  const ids = value.map((entry) => typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).id : null);
  if (ids.some((id) => typeof id !== "string" || !SAFE_ID.test(id))) throw new Error(`public Railway receipt refused: ${label} returned a malformed target ID`);
  return new Set(ids as string[]);
}

function projectsFromJson(raw: string) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("public Railway receipt refused: railway project list did not return JSON"); }
  if (!Array.isArray(value)) throw new Error("public Railway receipt refused: railway project list did not return a JSON list");
  return value.map((entry) => {
    const project = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : null;
    const services = project && typeof project.services === "object" && project.services !== null ? project.services as Record<string, unknown> : null;
    const edges = services?.edges;
    const deletedAt = project?.deletedAt;
    if (!project || typeof project.id !== "string" || !SAFE_ID.test(project.id) || (project.name !== undefined && typeof project.name !== "string") || (deletedAt !== undefined && deletedAt !== null && (typeof deletedAt !== "string" || !Number.isFinite(Date.parse(deletedAt)))) || (edges !== undefined && !Array.isArray(edges))) {
      throw new Error("public Railway receipt refused: railway project list returned a malformed target");
    }
    const serviceIds = Array.isArray(edges) ? edges.map((edge) => {
      const record = typeof edge === "object" && edge !== null ? edge as Record<string, unknown> : null;
      const node = record && typeof record.node === "object" && record.node !== null ? record.node as Record<string, unknown> : null;
      if (!node || typeof node.id !== "string" || !SAFE_ID.test(node.id)) throw new Error("public Railway receipt refused: railway project list returned a malformed service ID");
      return node.id;
    }) : null;
    return { id: project.id, name: typeof project.name === "string" ? project.name : null, deletedAt: typeof deletedAt === "string" ? deletedAt : null, serviceIds };
  });
}

export function railwayDeploymentIds(raw: string) { return idsFromJson(raw, "railway deployment list"); }

export function railwayProjectIds(raw: string) { return new Set(projectsFromJson(raw).map(({ id }) => id)); }

export async function recoverNewRailwayProject(command: RailwayCommand, cwd: string, before: ReadonlySet<string>, expectedName: string, deadline: number, now: RailwayClock, sleep: RailwaySleep) {
  const recovery = boundedRailwayCommand(command, deadline, now, CLEANUP_SLICE_MS);
  while (true) {
    try {
      const matches = projectsFromJson(recovery("railway", ["project", "list", "--json"], { cwd }))
        .filter(({ id, name }) => !before.has(id) && name === expectedName);
      if (matches.length > 1) throw new Error("public Railway receipt refused: ambiguous run-owned project recovery after railway init");
      if (matches.length === 1) return matches[0].id;
    } catch (error) {
      if (error instanceof Error && error.message.includes("ambiguous run-owned project recovery")) throw error;
      /* transient list/readback failure: retry to the caller's recovery deadline */
    }
    await boundedRailwaySleep(POLL_MS, deadline, now, sleep);
  }
}

export async function waitForNewRailwayDeployment(command: RailwayCommand, listArgs: string[], before: ReadonlySet<string>, deadline: number, now: RailwayClock, sleep: RailwaySleep) {
  while (true) {
    const added = [...railwayDeploymentIds(command("railway", listArgs))].filter((id) => !before.has(id));
    if (added.length > 1) throw new Error("public Railway receipt refused: one upload created multiple deployments");
    if (added.length === 1) return added[0];
    await boundedRailwaySleep(POLL_MS, deadline, now, sleep);
  }
}

const CLEANUP_INSTANCE_QUERY = "query H6CDeletedInstance($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { id environmentId serviceId activeDeployments { id status } } }";

function activeDeploymentCount(raw: string, expected: { environmentId: string; serviceId: string }) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("public Railway receipt refused: deleted service instance readback did not return JSON"); }
  const root = typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  const data = root && typeof root.data === "object" && root.data !== null ? root.data as Record<string, unknown> : null;
  const instance = data && typeof data.serviceInstance === "object" && data.serviceInstance !== null ? data.serviceInstance as Record<string, unknown> : null;
  if (!instance || typeof instance.id !== "string" || !SAFE_ID.test(instance.id) || instance.environmentId !== expected.environmentId || instance.serviceId !== expected.serviceId || !Array.isArray(instance.activeDeployments)) throw new Error("public Railway receipt refused: deleted service instance readback is malformed or belongs to another target");
  return instance.activeDeployments.length;
}

export async function deleteRailwayProject(command: RailwayCommand, projectId: string, cwd: string, deadline: number, now: RailwayClock, sleep: RailwaySleep, runtime?: RailwayRuntimeTarget) {
  const cleanup = boundedRailwayCommand(command, deadline, now, CLEANUP_SLICE_MS);
  while (true) {
    try { cleanup("railway", ["project", "delete", "--project", projectId, "--yes", "--json"], { cwd }); } catch { /* retry the same verified exact ID until the cleanup deadline */ }
    try {
      const projects = projectsFromJson(cleanup("railway", ["project", "list", "--json"], { cwd }));
      const target = projects.find(({ id }) => id === projectId);
      if (!target) return { disposition: "absent", deletionScheduledAt: null, projectActive: false, retainedServiceIds: [], activeDeploymentCount: 0 } satisfies RailwayProjectCleanup;
      const expectedServices = runtime?.serviceId ? [runtime.serviceId] : target.serviceIds;
      const serviceShapeValid = target.serviceIds && (runtime ? JSON.stringify([...target.serviceIds].sort()) === JSON.stringify([...(expectedServices ?? [])].sort()) : target.serviceIds.length === 0);
      if (target.deletedAt !== null && serviceShapeValid && target.serviceIds) {
        const count = runtime ? target.serviceIds.reduce((total, serviceId) => { const expected = { environmentId: runtime.environmentId, serviceId }; return total + activeDeploymentCount(cleanup("railway", ["api", CLEANUP_INSTANCE_QUERY, "--variables", JSON.stringify(expected)], { cwd }), expected); }, 0) : 0;
        if (count === 0) return { disposition: "provider-scheduled-purge", deletionScheduledAt: target.deletedAt, projectActive: false, retainedServiceIds: target.serviceIds, activeDeploymentCount: 0 } satisfies RailwayProjectCleanup;
      }
    } catch { /* retry readback; absence must be observed, never assumed */ }
    await boundedRailwaySleep(POLL_MS, deadline, now, sleep);
  }
}
