// Readiness: the shapes a package contributes to an application's composition,
// and one I/O-free check that refuses a composition before it takes traffic.
// The check reads only its input; the schema probe port does the I/O.

import {
  PLATFORM_OUTBOX_EVENT_TYPES,
  matchOutboxEventTypeDeclaration,
  type OutboxEventTypeDeclaration,
  type OutboxHandler,
} from "../outbox/index.js";
import type {
  PlatformHttpRequest,
  PlatformHttpResponse,
  PlatformJobInvocation,
} from "../platform-runtime/ports.js";
import type { SchemaProbePort } from "./schemaProbe.js";

/**
 * One database object a package calls. `name` is `[schema.]name`, or
 * `[schema.]table.column` for a column. A function's `signature` lists its
 * argument types as PostgreSQL prints them (`timestamp with time zone`, not
 * `timestamptz`), because older functions with the same name can coexist.
 * @beta
 */
export interface RequiredSchemaObject {
  readonly kind: "table" | "column" | "function";
  readonly name: string;
  readonly signature?: string;
}

/**
 * The schema a package needs. `version` names the newest migration the
 * package's shipped SQL requires.
 * @beta
 */
export interface RequiredSchema {
  readonly version: string;
  readonly objects: ReadonlyArray<RequiredSchemaObject>;
}

/**
 * What a schedule's run returns: an outcome, which may always be `disabled`
 * when the lease refuses a disabled job, and the package's full typed result.
 * Mapping it to an HTTP response is the application's job.
 * @beta
 */
export interface ScheduleRunResult<TOutcome extends string = string, TDetail = unknown> {
  readonly outcome: TOutcome | "disabled";
  readonly detail: TDetail;
}

/**
 * A scheduled job a package runs. `jobId` is the job name its lease records;
 * `schedule` is the expected cadence. `run` takes the lease itself.
 * @beta
 */
export interface ScheduleDeclaration<TOutcome extends string = string, TDetail = unknown> {
  readonly jobId: string;
  readonly schedule: string;
  run(invocation: PlatformJobInvocation): Promise<ScheduleRunResult<TOutcome, TDetail>>;
}

/** @beta */
export interface RouteDeclaration {
  readonly method: string;
  readonly path: string;
  handle(req: PlatformHttpRequest, res: PlatformHttpResponse): Promise<unknown> | unknown;
}

/**
 * What a package declares about itself. Each field is empty, never absent,
 * when it does not apply; `requiredSchema` is `null` for a package that owns no
 * database objects.
 * @beta
 */
export interface PackageManifest {
  readonly name: string;
  readonly version: string;
  /** Event types the package handles, and event types it emits and so owns. */
  readonly events: {
    readonly handles: ReadonlyArray<string>;
    readonly emits: ReadonlyArray<string>;
  };
  readonly schedules: ReadonlyArray<{ readonly jobId: string; readonly schedule: string }>;
  readonly routes: ReadonlyArray<{ readonly method: string; readonly path: string }>;
  /** Each required port, and whether the factory received a value for it. */
  readonly ports: ReadonlyArray<{ readonly name: string; readonly wired: boolean }>;
  readonly requiredSchema: RequiredSchema | null;
  /** Environment variables that must be present; optional ones are not listed. */
  readonly env: ReadonlyArray<string>;
}

/**
 * What a rail or capability factory returns.
 * @beta
 */
export interface Contribution {
  readonly handlers: ReadonlyArray<OutboxHandler>;
  readonly schedules: ReadonlyArray<ScheduleDeclaration>;
  readonly routes: ReadonlyArray<RouteDeclaration>;
  readonly manifest: PackageManifest;
}

/**
 * The readiness codes. Each is public API: renaming or removing one is a
 * breaking change.
 * @beta
 */
export const READINESS_CODES = Object.freeze({
  PORT_MISSING: "OPENLUP_E_PORT_MISSING",
  EVENT_UNHANDLED: "OPENLUP_E_EVENT_UNHANDLED",
  EVENT_DUPLICATE: "OPENLUP_E_EVENT_DUPLICATE",
  SCHEDULE_UNBOUND: "OPENLUP_E_SCHEDULE_UNBOUND",
  SCHEMA_BEHIND: "OPENLUP_E_SCHEMA_BEHIND",
  SET_MISMATCH: "OPENLUP_E_SET_MISMATCH",
  ENV_MISSING: "OPENLUP_E_ENV_MISSING",
} as const);

/** @beta */
export type ReadinessCode = (typeof READINESS_CODES)[keyof typeof READINESS_CODES];

/**
 * One readiness failure: a stable code, the package that raised it, the
 * subject (a port, event type, schedule, schema object, package or variable)
 * and a one-sentence fix.
 * @beta
 */
export interface ReadinessFailure {
  readonly code: `OPENLUP_E_${string}`;
  readonly package: string;
  readonly subject: string;
  readonly fix: string;
}

/** @beta */
export interface ReadinessInput {
  readonly contributions: ReadonlyArray<Contribution>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly schemaProbe: SchemaProbePort;
  /** The `jobId` of every schedule the host triggers. */
  readonly boundSchedules: ReadonlyArray<string>;
  /** Event types with no handler on purpose; exact types or `.`-ended prefixes. */
  readonly eventTypeDeclarations?: ReadonlyArray<OutboxEventTypeDeclaration>;
  /** Loaded packages that contribute nothing, such as `@openlup/core` itself. */
  readonly packages?: ReadonlyArray<{ readonly name: string; readonly version: string }>;
}

/**
 * The complete result. `declared` lists each event type that has no handler
 * but a declaration, which is a declared state and not a failure.
 * @beta
 */
export interface ReadinessReport {
  readonly ok: boolean;
  readonly failures: ReadonlyArray<ReadinessFailure>;
  readonly declared: ReadonlyArray<{
    readonly eventType: string;
    readonly declaration: OutboxEventTypeDeclaration;
  }>;
}

const KERNEL_PACKAGE = "@openlup/core";
const SET_PREFIX = "@openlup/";

// Code-unit order, so the report is identical under every locale.
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const byPackageThenSubject = (left: ReadinessFailure, right: ReadinessFailure): number =>
  compareText(left.package, right.package) || compareText(left.subject, right.subject);

function compareVersions(left: string, right: string): number {
  const a = left.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const b = right.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return compareText(left, right);
}

function assertDeclaration(declaration: OutboxEventTypeDeclaration): void {
  const { eventType, state, owner, reason } = declaration;
  const segments = eventType.endsWith(".") ? eventType.slice(0, -1).split(".") : eventType.split(".");
  if (
    eventType.trim() !== eventType ||
    segments.some((segment) => segment.length === 0) ||
    (state !== "ignored" && state !== "dormant") ||
    owner.trim().length === 0 ||
    reason.trim().length === 0
  ) {
    throw new TypeError(
      `event type declaration needs a trimmed type or a "."-ended prefix, the state ignored or dormant, an owner and a reason: ${JSON.stringify(declaration)}`,
    );
  }
}

function describeObject(object: { kind: string; name: string; signature?: string }): string {
  return object.signature === undefined
    ? `${object.kind} ${object.name}`
    : `${object.kind} ${object.name}(${object.signature})`;
}

/**
 * Checks an application's composition before it takes traffic, and reports
 * every failure at once: grouped in `READINESS_CODES` order, then sorted by
 * package and subject. It performs no I/O of its own: the schema probe port
 * answers for the database, and it is called at most once. A failing check
 * refuses the new version; it never stops a version that is already serving.
 * It throws on a malformed declaration or probe answer instead of guessing.
 * @beta
 */
export async function checkReadiness(input: ReadinessInput): Promise<ReadinessReport> {
  const declarations = input.eventTypeDeclarations ?? [];
  declarations.forEach(assertDeclaration);
  const manifests = input.contributions.map((contribution) => contribution.manifest);
  const failures: Record<ReadinessCode, ReadinessFailure[]> = {
    OPENLUP_E_PORT_MISSING: [],
    OPENLUP_E_EVENT_UNHANDLED: [],
    OPENLUP_E_EVENT_DUPLICATE: [],
    OPENLUP_E_SCHEDULE_UNBOUND: [],
    OPENLUP_E_SCHEMA_BEHIND: [],
    OPENLUP_E_SET_MISMATCH: [],
    OPENLUP_E_ENV_MISSING: [],
  };
  const fail = (code: ReadinessCode, pkg: string, subject: string, fix: string): void => {
    failures[code].push({ code, package: pkg, subject, fix });
  };

  for (const manifest of manifests) {
    for (const port of manifest.ports) {
      if (!port.wired) {
        fail(READINESS_CODES.PORT_MISSING, manifest.name, port.name,
          `Pass a ${port.name} port to the ${manifest.name} factory.`);
      }
    }
    for (const name of manifest.env) {
      const value = input.env[name];
      if (value === undefined || value.trim().length === 0) {
        fail(READINESS_CODES.ENV_MISSING, manifest.name, name,
          `Set ${name} in this deployment's environment.`);
      }
    }
  }

  // Event types: the kernel vocabulary plus every type a manifest handles or emits.
  // A manifest that emits a type owns it; the kernel's listing is not an owner.
  const handled = new Set(input.contributions.flatMap((contribution) =>
    contribution.handlers.map((handler) => handler.eventType)));
  const vocabularyOwners = new Map(PLATFORM_OUTBOX_EVENT_TYPES.map((entry) => [entry.eventType, entry.owner]));
  const emitters = new Map<string, string[]>();
  const handlerDeclarers = new Map<string, string[]>();
  const record = (index: Map<string, string[]>, eventType: string, name: string): void => {
    const names = index.get(eventType) ?? [];
    if (!names.includes(name)) names.push(name);
    index.set(eventType, names.sort(compareText));
  };
  for (const manifest of manifests) {
    for (const eventType of manifest.events.emits) record(emitters, eventType, manifest.name);
    for (const eventType of manifest.events.handles) record(handlerDeclarers, eventType, manifest.name);
  }
  const eventTypes = new Set([...vocabularyOwners.keys(), ...emitters.keys(), ...handlerDeclarers.keys()]);
  const declared: Array<{ eventType: string; declaration: OutboxEventTypeDeclaration }> = [];
  for (const eventType of [...eventTypes].sort(compareText)) {
    if (handled.has(eventType)) continue;
    const declaration = matchOutboxEventTypeDeclaration(eventType, declarations);
    if (declaration) {
      declared.push({ eventType, declaration });
      continue;
    }
    const raisedBy = emitters.get(eventType)?.[0] ?? handlerDeclarers.get(eventType)?.[0] ?? KERNEL_PACKAGE;
    const owner = vocabularyOwners.get(eventType) ?? raisedBy;
    fail(READINESS_CODES.EVENT_UNHANDLED, raisedBy, eventType,
      `Compose a handler for ${eventType} (owner ${owner}), or declare it ignored or dormant.`);
  }
  for (const [eventType, claimants] of emitters) {
    if (claimants.length < 2) continue;
    for (const pkg of claimants) {
      fail(READINESS_CODES.EVENT_DUPLICATE, pkg, eventType,
        `Keep ${eventType} in the emits of one package only; ${claimants.join(", ")} all claim it.`);
    }
  }

  const bound = new Set(input.boundSchedules);
  input.contributions.forEach((contribution) => {
    const schedules = new Map<string, string>();
    for (const schedule of [...contribution.manifest.schedules, ...contribution.schedules]) {
      schedules.set(schedule.jobId, schedule.schedule);
    }
    for (const [jobId, cadence] of schedules) {
      if (!bound.has(jobId)) {
        fail(READINESS_CODES.SCHEDULE_UNBOUND, contribution.manifest.name, jobId,
          `Bind ${jobId} to a host trigger running at ${cadence}.`);
      }
    }
  });

  // One probe for every required object of every contribution.
  const required = manifests.flatMap((manifest) =>
    (manifest.requiredSchema?.objects ?? []).map((object) => ({ manifest, object })));
  if (required.length > 0) {
    const present = await input.schemaProbe.probe(required.map(({ object }) => object));
    if (present.length !== required.length) {
      throw new TypeError(`schema probe answered ${present.length} of ${required.length} objects`);
    }
    required.forEach(({ manifest, object }, index) => {
      if (!present[index]) {
        fail(READINESS_CODES.SCHEMA_BEHIND, manifest.name, describeObject(object),
          `Apply ${manifest.name}'s migrations up to ${manifest.requiredSchema?.version}, then run readiness again.`);
      }
    });
  }

  const loaded = new Map<string, string>();
  for (const pkg of [...(input.packages ?? []), ...manifests]) {
    if (pkg.name.startsWith(SET_PREFIX)) loaded.set(pkg.name, pkg.version);
  }
  const versions = [...new Set(loaded.values())].sort(compareVersions);
  if (versions.length > 1) {
    const target = versions[versions.length - 1];
    const names = [...loaded.keys()].sort(compareText);
    const command = `npm install --save-exact ${names.map((name) => `${name}@${target}`).join(" ")}`;
    for (const [name, version] of loaded) {
      if (version !== target) {
        fail(READINESS_CODES.SET_MISMATCH, name, `${name}@${version}`,
          `Run ${command} so every @openlup package is ${target}.`);
      }
    }
  }

  const all = Object.values(failures).flatMap((list) => [...list].sort(byPackageThenSubject));
  return { ok: all.length === 0, failures: all, declared };
}

/** @beta */
export type { SchemaProbePort, SchemaProbeQuery } from "./schemaProbe.js";
/** @beta */
export { buildSchemaProbe, readSchemaProbe } from "./schemaProbe.js";
