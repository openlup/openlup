import { declarationIssues, manifestShape, schemaObjectShape } from "./declarations.js";
import { schemaObjectKey } from "./schemaProbe.js";
import type { ReadinessInput, ReadinessIssue, ReadinessReport, RequiredSchema, SchemaObservation, Contribution } from "./contracts.js";
export * from "./contracts.js";
export { schemaObjectKey, buildSchemaObjectProbe, createSchemaProbe } from "./schemaProbe.js";
/** @beta Evaluates supplied facts; never performs migration or effect work. */
export async function checkReadiness(input: ReadinessInput): Promise<ReadinessReport> {
  const issues = declarationIssues(input);
  let unknown = issues.some((i) => ["input", "candidate", "inventory", "loaded-package", "schemaProbe", "probeTimeoutMs"].includes(i.subject));
  const add = (code: ReadinessIssue["code"], pkg: string, subject: string, fix: string, observation?: string) => {
    issues.push({ code, package: pkg, subject, fix, ...(observation ? { observation } : {}) });
  };
  const report = (): ReadinessReport => ({ state: unknown ? "unknown" : issues.length ? "unsatisfied" : "ready", candidate: input?.candidate,
    loadedPackages: input?.loadedPackages ?? [], issues: issues.sort((a,b) => [a.code,a.package,a.subject,a.observation ?? ""].join("|").localeCompare([b.code,b.package,b.subject,b.observation ?? ""].join("|"))) });
  if (!input || !Array.isArray(input.loadedPackages) || !Array.isArray(input.contributions)) return report();
  const contributions: readonly Contribution[] = input.contributions.filter((c: Contribution) => manifestShape.safeParse(c?.manifest).success && Array.isArray(c.handlers) && c.handlers.every((h) => h && typeof h.eventType === "string" && Number.isFinite(h.timeoutMs) && h.timeoutMs > 0) && Array.isArray(c.schedules) && c.schedules.every((s) => s && typeof s.id === "string" && typeof s.run === "function") && Array.isArray(c.routes) && c.routes.every((r) => r && typeof r.id === "string" && typeof r.handle === "function"));
  const loaded = input.loadedPackages.filter((p) => p && typeof p.name === "string" && typeof p.version === "string");
  const packages = new Map<string, number>();
  for (const p of loaded) packages.set(p.name, (packages.get(p.name) ?? 0) + 1);
  if (packages.get("@openlup/core") !== 1 || loaded.find((p) => p.name === "@openlup/core")?.kind !== "kernel") add("OPENLUP_E_SET_MISMATCH", "@openlup/core", "kernel", "Observe exactly one core kernel.");
  const set = loaded.find((p) => p.name === "@openlup/core")?.version;
  const install = `Align the complete set: npm install ${[...new Set(loaded.map((p) => p.name))].sort().map((name) => `${name}@${set ?? "<set-version>"}`).join(" ")}`;
  for (const [name,count] of packages) if (count > 1) add("OPENLUP_E_SET_MISMATCH", name, "inventory", "Observe each loaded package exactly once.");
  for (const p of loaded) {
    if (p.version !== set || (p.kind === "kernel" && p.name !== "@openlup/core")) add("OPENLUP_E_SET_MISMATCH", p.name, "version", install);
    if (p.kind !== "kernel" && contributions.filter((c) => c.manifest.name === p.name).length !== 1) add("OPENLUP_E_SET_MISMATCH", p.name, "contribution", "Compose exactly one contribution for each loaded non-kernel package.");
  }
  const handlers = new Map<string,string[]>(); const emitters = new Map<string,string[]>();
  const events = new Set<string>();
  for (const v of (Array.isArray(input.vocabulary) ? input.vocabulary : [])) {
    if (v && typeof v.eventType === "string") {
      if (events.has(v.eventType)) add("OPENLUP_E_EVENT_DUPLICATE", v.owner, v.eventType, "Declare each vocabulary identity once.");
      events.add(v.eventType);
    }
  }
  for (const c of contributions) {
    const m = c.manifest;
    const p = loaded.filter((p) => p.name === m.name);
    if (p.length !== 1 || p[0]?.version !== m.version || p[0]?.kind !== m.kind) add("OPENLUP_E_SET_MISMATCH", m.name, "manifest", "Match the contribution to its observed installed package.");
    for (const type of m.emits) {
      events.add(type);
      if (m.kind !== "kernel") emitters.set(type, [...(emitters.get(type) ?? []), m.name]);
    }
    const actual = c.handlers.map((h) => h?.eventType);
    for (const type of new Set([...m.handles,...actual])) {
      if (m.handles.filter((x) => x === type).length !== 1 || actual.filter((x) => x === type).length !== 1) add("OPENLUP_E_EVENT_DUPLICATE", m.name, type, "Match each declared consumer to exactly one composed handler descriptor.");
      else handlers.set(type, [...(handlers.get(type) ?? []), m.name]);
      events.add(type);
    }
    for (const port of m.requiredPorts) if (!isPort(input.bindings?.ports?.[`${m.name}:${port}`])) add("OPENLUP_E_PORT_MISSING", m.name, port, "Bind the selected adapter port in composition.");
    for (const env of m.env) if (typeof input.bindings?.env?.[env] !== "string" || !input.bindings.env[env]?.trim()) add("OPENLUP_E_ENV_MISSING", m.name, env, "Supply the named environment variable without exposing its value.");
    for (const id of new Set([...m.schedules.map((s) => s.id),...c.schedules.map((s) => s?.id)])) {
      const declarations = m.schedules.filter((s) => s.id === id), actual = c.schedules.filter((s) => s?.id === id);
      if (declarations.length !== 1 || actual.length !== 1 || declarations[0]?.cadenceSeconds !== actual[0]?.cadenceSeconds || typeof actual[0]?.run !== "function" || input.bindings?.triggers?.[`${m.name}:${id}`] !== actual[0]?.run) add("OPENLUP_E_SCHEDULE_UNBOUND", m.name, id, "Bind the actual schedule with its declared cadence to one host trigger.");
    }
    for (const id of new Set([...m.routes,...c.routes.map((r) => r?.id)])) if (m.routes.filter((r) => r === id).length !== 1 || c.routes.filter((r) => r?.id === id && typeof r.handle === "function").length !== 1 || input.bindings?.routes?.[`${m.name}:${id}`] !== c.routes.find((r) => r.id === id)?.handle) add("OPENLUP_E_PORT_MISSING", m.name, id, "Bind the declared route to its actual host entry.");
  }
  for (const [type,owners] of [...emitters,...handlers]) if (owners.length > 1) add("OPENLUP_E_EVENT_DUPLICATE", owners.sort().join(","), type, "Use one non-kernel producer owner and one composed consumer per event.");
  for (const type of events) if (!handlers.has(type) && !(Array.isArray(input.exemptions) ? input.exemptions : []).some((e) => e && typeof e.reason === "string" && e.reason.trim() && typeof e.owner === "string" && typeof e.pattern === "string" && ["ignored", "dormant"].includes(e.state) && typeof e.prefix === "boolean" && (e.prefix ? type.startsWith(e.pattern) : type === e.pattern))) add("OPENLUP_E_EVENT_UNHANDLED", "@openlup/core", type, "Register a handler or an explicit owned ignored/dormant declaration.");
  for (const c of contributions) {
    const req = c.manifest.requiredSchema;
    if (!req) continue;
    if (issues.some((i) => ["schemaProbe", "probeTimeoutMs"].includes(i.subject))) { unknown = true; continue; }
    let observation: unknown;
    try { observation = await boundedObservation(input, req); }
    catch { unknown = true; add("OPENLUP_E_SCHEMA_BEHIND", c.manifest.name, req.version, `Observe the selected adapter and apply ${req.migration} through your migration chain.`, "probe_unavailable"); continue; }
    if (!validObservation(observation, req)) { unknown = true; add("OPENLUP_E_SCHEMA_BEHIND", c.manifest.name, req.version, "Return one valid observation for every requested schema object.", "probe_malformed_or_incomplete"); continue; }
    if (!observation.database || observation.database !== input.candidate?.database || observation.version === null) { unknown = true; add("OPENLUP_E_SCHEMA_BEHIND", c.manifest.name, req.version, "Observe the exact candidate database and applied migration identity.", "identity_or_version_unknown"); }
    else if (observation.version !== req.version) add("OPENLUP_E_SCHEMA_BEHIND", c.manifest.name, req.version, `Apply ${req.migration} and observe its version.`, "version_mismatch");
    for (const {object,present} of observation.objects) if (present !== true) {
      unknown ||= present === null;
      add("OPENLUP_E_SCHEMA_BEHIND", c.manifest.name, schemaObjectKey(object), `Apply ${req.migration} for the selected adapter.`, present === null ? "object_unknown" : "object_absent");
    }
  }
  return report();
}
function validObservation(value: unknown, requirement: RequiredSchema): value is SchemaObservation {
  if (!value || typeof value !== "object") return false;
  const v = value as SchemaObservation;
  if (typeof v.database !== "string" || !(v.version === null || typeof v.version === "string") || !Array.isArray(v.objects)) return false;
  const requested = new Set(requirement.objects.map(schemaObjectKey)), seen = new Set<string>();
  for (const item of v.objects) {
    if (!item || !schemaObjectShape.safeParse(item.object).success || ![true,false,null].includes(item.present)) return false;
    const key = schemaObjectKey(item.object);
    if (!requested.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return seen.size === requested.size;
}
async function boundedObservation(input: ReadinessInput, requirement: RequiredSchema): Promise<unknown> {
  const timers = globalThis as unknown as { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  let timer: unknown;
  try { return await Promise.race([input.schemaProbe.observe(requirement), new Promise((_,reject) => { timer = timers.setTimeout(() => reject(new Error("probe_timeout")), input.probeTimeoutMs ?? 3000); })]); }
  finally { if (timer !== undefined) timers.clearTimeout(timer); }
}

function isPort(value: unknown): boolean { return typeof value === "function" || (value !== null && typeof value === "object" && !Array.isArray(value)); }
