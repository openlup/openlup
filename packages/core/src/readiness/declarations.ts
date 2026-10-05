import { z } from "zod";
import type { ReadinessInput, ReadinessIssue, Contribution } from "./contracts.js";
const name = z.string().min(1).max(240).regex(/^[a-zA-Z0-9@_./:-]+$/);
const version = z.string().regex(/^0\.\d+\.\d+$/);
const list = z.array(name).refine((items) => new Set(items).size === items.length);
const kind = z.enum(["kernel", "rail", "capability", "implementation"]);
export const schemaObjectShape = z.object({ kind: z.enum(["table", "column", "function"]), name,
  signature: z.string().max(1000).optional() }).strict().refine((o) =>
    o.name.split(".").length === (o.kind === "column" ? 3 : 2) && (o.kind !== "function" || o.signature !== undefined));
export const manifestShape = z.object({ name: name.regex(/^@openlup\/[a-z0-9-]+$/), version, kind,
  emits: list, handles: list, schedules: z.array(z.object({ id: name, cadenceSeconds: z.number().finite().positive() }).strict()),
  routes: list, requiredPorts: list, env: list,
  requiredSchema: z.object({ version: name, migration: name, objects: z.array(schemaObjectShape) }).strict().optional(),
}).strict();
/** Validate declarations without invoking a handler, schedule, route or probe. */
export function declarationIssues(input: ReadinessInput): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  const issue = (subject: string, fix: string, code: ReadinessIssue["code"] = "OPENLUP_E_SET_MISMATCH") => issues.push({ code, package: "@openlup/core", subject, fix });
  if (!input || typeof input !== "object") { issue("input", "Supply complete candidate observations."); return issues; }
  if (!input.candidate || ![input.candidate.artifact, input.candidate.configuration, input.candidate.environment, input.candidate.database, input.candidate.schema].every((v) => typeof v === "string" && /^[a-zA-Z0-9_.:/-]{1,240}$/.test(v))) issue("candidate", "Supply sanitized immutable artifact, configuration, environment and database identities.");
  if (input.inventoryComplete !== true) issue("inventory", "Observe the complete installed package inventory, including core.");
  if (!Array.isArray(input.loadedPackages) || !Array.isArray(input.contributions)) { issue("inventory", "Supply loaded packages and contributions as arrays."); return issues; }
  for (const pkg of input.loadedPackages) if (!z.object({ name, version, kind }).strict().safeParse(pkg).success) issue("loaded-package", "Supply a valid observed package name, version and kind.");
  for (const c of input.contributions as readonly Contribution[]) {
    if (!manifestShape.safeParse(c?.manifest).success) { issue("manifest", "Supply a valid complete manifest with unique declarations."); continue; }
    if (!Array.isArray(c.handlers) || c.handlers.some((h) => !name.safeParse(h?.eventType).success || !Number.isFinite(h?.timeoutMs) || h?.timeoutMs <= 0)) issue(c.manifest.name, "Supply valid shared handler descriptors.", "OPENLUP_E_EVENT_UNHANDLED");
    if (!Array.isArray(c.schedules) || c.schedules.some((s) => !name.safeParse(s?.id).success || !Number.isFinite(s?.cadenceSeconds) || s?.cadenceSeconds <= 0 || typeof s?.run !== "function")) issue(c.manifest.name, "Supply actual runnable schedules.", "OPENLUP_E_SCHEDULE_UNBOUND");
    if (!Array.isArray(c.routes) || c.routes.some((r) => !name.safeParse(r?.id).success || typeof r?.handle !== "function")) issue(c.manifest.name, "Supply actual route registrations.", "OPENLUP_E_PORT_MISSING");
    const objects = c.manifest.requiredSchema?.objects ?? [];
    if (new Set(objects.map((o) => `${o.kind}:${o.name}:${o.signature ?? ""}`)).size !== objects.length) issue(c.manifest.name, "Remove duplicate schema requirements.", "OPENLUP_E_SCHEMA_BEHIND");
  }
  if (!Array.isArray(input.vocabulary) || input.vocabulary.some((v) => !name.safeParse(v?.eventType).success || !name.safeParse(v?.owner).success)) issue("vocabulary", "Supply explicit vocabulary entries with owners.", "OPENLUP_E_EVENT_UNHANDLED");
  if (!Array.isArray(input.exemptions) || input.exemptions.some((e) => !name.safeParse(e?.pattern).success || typeof e?.prefix !== "boolean" || !name.safeParse(e?.owner).success || typeof e?.reason !== "string" || !e?.reason.trim() || !["ignored", "dormant"].includes(e?.state))) issue("exemptions", "Supply explicit owned exemptions with reasons.", "OPENLUP_E_EVENT_UNHANDLED");
  if (!input.bindings || [input.bindings.ports, input.bindings.routes, input.bindings.triggers, input.bindings.env].some((v) => !v || typeof v !== "object" || Array.isArray(v))) issue("bindings", "Supply actual host bindings.", "OPENLUP_E_PORT_MISSING");
  if (!input.schemaProbe || typeof input.schemaProbe.observe !== "function") issue("schemaProbe", "Bind a schema observation port.", "OPENLUP_E_SCHEMA_BEHIND");
  if (input.probeTimeoutMs !== undefined && (!Number.isFinite(input.probeTimeoutMs) || input.probeTimeoutMs < 1 || input.probeTimeoutMs > 30000)) issue("probeTimeoutMs", "Use a bounded probe timeout from 1 to 30000 ms.", "OPENLUP_E_SCHEMA_BEHIND");
  return issues;
}
