import type { OutboxHandlerDescriptor } from "../outbox/index.js";
import type { EventVocabularyEntry } from "../outbox/vocabulary.js";
/** @beta */
export const READINESS_CODES = ["OPENLUP_E_PORT_MISSING", "OPENLUP_E_EVENT_UNHANDLED", "OPENLUP_E_EVENT_DUPLICATE", "OPENLUP_E_SCHEDULE_UNBOUND", "OPENLUP_E_SCHEMA_BEHIND", "OPENLUP_E_SET_MISMATCH", "OPENLUP_E_ENV_MISSING"] as const;
/** @beta */
export type ReadinessCode = typeof READINESS_CODES[number];
/** @beta */
export interface ReadinessIssue { code: ReadinessCode; package: string; subject: string; fix: string; observation?: string }
/** @beta */
export interface SchemaObject { kind: "table" | "column" | "function"; name: string; signature?: string }
/** @beta Version is an adapter-specific migration identity, not inferred from object existence. */
export interface RequiredSchema { version: string; migration: string; objects: readonly SchemaObject[] }
/** @beta */
export interface PackageManifest {
  name: string; version: string; kind: "kernel" | "rail" | "capability" | "implementation";
  emits: readonly string[]; handles: readonly string[];
  schedules: readonly { id: string; cadenceSeconds: number }[];
  routes: readonly string[]; requiredPorts: readonly string[]; env: readonly string[];
  requiredSchema?: RequiredSchema;
}
/** @beta Run-bound handlers are represented by their shared inert descriptors. */
export interface Contribution {
  manifest: PackageManifest;
  handlers: readonly OutboxHandlerDescriptor[];
  schedules: readonly { id: string; cadenceSeconds: number; run: (...args: never[]) => unknown }[];
  routes: readonly { id: string; handle: (...args: never[]) => unknown }[];
}
/** @beta Host-observed inventory, including core. The loader owns completeness. */
export interface LoadedPackage { name: string; version: string; kind: PackageManifest["kind"] }
/** @beta Candidate identity must change when configuration, schema or artifact changes. */
export interface CandidateIdentity { artifact: string; configuration: string; environment: string; database: string; schema: string }
/** @beta */
export interface EventExemption { pattern: string; prefix: boolean; owner: string; reason: string; state: "ignored" | "dormant" }
/** @beta */
export interface ReadinessInput {
  candidate: CandidateIdentity; inventoryComplete: boolean;
  loadedPackages: readonly LoadedPackage[]; contributions: readonly Contribution[];
  vocabulary: readonly EventVocabularyEntry[]; exemptions: readonly EventExemption[];
  bindings: { ports: Readonly<Record<string, unknown>>; triggers: Readonly<Record<string, unknown>>; routes: Readonly<Record<string, unknown>>; env: Readonly<Record<string, string | undefined>> };
  schemaProbe: SchemaProbePort; probeTimeoutMs?: number;
}
/** @beta A bounded catalog observation, not proof of SQL bodies, ACL or recovery. */
export interface SchemaObservation {
  database: string; version: string | null;
  objects: readonly { object: SchemaObject; present: boolean | null }[];
}
/** @beta */
export interface SchemaProbePort { observe(requirement: RequiredSchema): Promise<SchemaObservation> }
/** @beta Each operation commits before resolving; never lend a producer transaction to dispatch. */
export interface SqlExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}
/** @beta */
export interface ReadinessReport {
  state: "ready" | "unsatisfied" | "unknown";
  candidate: CandidateIdentity; loadedPackages: readonly LoadedPackage[]; issues: readonly ReadinessIssue[];
}
