/** Capture-only A+B chronology and one-shot completion capability. */
import { spawnSync } from "node:child_process";
import path from "node:path";
export type ActualJourneyResult<Skeleton extends "a" | "b" = "a" | "b"> = Readonly<{ skeleton: Skeleton; actualArtifactPath: string; finalArtifactPath: string }>;
declare const completionCapabilityBrand: unique symbol;
export type CompletionCapability = Readonly<{ [completionCapabilityBrand]: never }>;
export type ReferenceJourneyCaptureOperations<Snapshot> = Readonly<{
  session: object;
  runActualA: () => Promise<ActualJourneyResult<"a">>;
  runActualB: () => Promise<ActualJourneyResult<"b">>;
  snapshot: () => Promise<Snapshot>;
  complete: (capability: CompletionCapability, finalArtifactPath: string) => Promise<void>;
}>;
export type ReferenceJourneyCaptureResult<Snapshot> = Readonly<{ snapshot: Snapshot; artifactPath: string }>;
export type CaptureLocalStatus = Readonly<{ API_URL: string; DB_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string }>;

const capabilities = new WeakMap<object, Readonly<{ session: object; complete: ReferenceJourneyCaptureOperations<unknown>["complete"] }>>();
function mint(session: object, complete: ReferenceJourneyCaptureOperations<unknown>["complete"]): CompletionCapability { const capability = Object.freeze(Object.create(null)) as CompletionCapability; capabilities.set(capability, { session, complete }); return capability; }
export function consumeReferenceJourneyCompletion(capability: CompletionCapability, session: object, complete: ReferenceJourneyCaptureOperations<unknown>["complete"]): void { const binding = capabilities.get(capability); if (!binding || binding.session !== session || binding.complete !== complete) throw new Error("capture completion capability rejected"); capabilities.delete(capability); }
function loopback(raw: string): boolean { try { return ["localhost", "127.0.0.1", "::1"].includes(new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase()); } catch { return false; } }
function loopbackDatabase(raw: string): boolean { try { const url = new URL(raw); return (url.protocol === "postgres:" || url.protocol === "postgresql:") && !url.search && !url.hash && ["127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, "").toLowerCase()); } catch { return false; } }

export function captureLocalStatus(workdir: string): CaptureLocalStatus {
  if (!path.isAbsolute(workdir) || path.resolve(workdir) !== workdir) throw new Error("capture workdir rejected");
  const result = spawnSync("supabase", ["--workdir", workdir, "status", "-o", "json"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) throw new Error("Capture Supabase is not running"); const parsed = JSON.parse(result.stdout) as Partial<CaptureLocalStatus>;
  for (const key of ["API_URL", "DB_URL", "ANON_KEY", "SERVICE_ROLE_KEY"] as const) if (!parsed[key]) throw new Error(`capture status omitted ${key}`); if (!loopback(parsed.API_URL!) || !loopbackDatabase(parsed.DB_URL!)) throw new Error("capture status returned a non-loopback endpoint"); return parsed as CaptureLocalStatus;
}

function actual<S extends "a" | "b">(result: ActualJourneyResult<S>, skeleton: S): ActualJourneyResult<S> {
  if (!result || result.skeleton !== skeleton || typeof result.actualArtifactPath !== "string" || !result.actualArtifactPath || typeof result.finalArtifactPath !== "string" || !result.finalArtifactPath) throw new Error("capture journey artifact path mismatch");
  return result;
}

/** Invoke each fixed operation exactly once; failures short-circuit every later operation. */
export async function runReferenceJourneyCapture<Snapshot>(operations: ReferenceJourneyCaptureOperations<Snapshot>): Promise<ReferenceJourneyCaptureResult<Snapshot>> {
  if (!operations.session || typeof operations.session !== "object") throw new Error("capture session rejected");
  const a = actual(await operations.runActualA(), "a"), b = actual(await operations.runActualB(), "b");
  if (a.actualArtifactPath === b.actualArtifactPath || a.finalArtifactPath !== b.finalArtifactPath || a.finalArtifactPath === a.actualArtifactPath || b.finalArtifactPath === b.actualArtifactPath) throw new Error("capture journey artifact ownership mismatch");
  const snapshot = await operations.snapshot();
  if (snapshot === undefined) throw new Error("capture snapshot missing");
  const capability = mint(operations.session, operations.complete as ReferenceJourneyCaptureOperations<unknown>["complete"]); let failure: unknown;
  try { await operations.complete(capability, a.finalArtifactPath); } catch (error) { failure = error; }
  const unconsumed = capabilities.delete(capability); if (failure) throw failure; if (unconsumed) throw new Error("capture completion capability was not consumed");
  return Object.freeze({ snapshot, artifactPath: a.finalArtifactPath });
}
