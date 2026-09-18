import type { AcquisitionEvidencePort } from "../../domains/marketing/research/acquisitionEvidencePorts.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

type Env = Record<string, string | undefined>;
export type AcquisitionEvidencePortFactory = (env: { connectionString: string }) => AcquisitionEvidencePort | Promise<AcquisitionEvidencePort>;

const bindings = new Map<string, Promise<AcquisitionEvidencePort>>();

async function createDefault(env: { connectionString: string }): Promise<AcquisitionEvidencePort> {
  const adapter = await import("../../adapters/postgres/marketing/acquisitionEvidenceRoutines.js");
  return adapter.createPostgresAcquisitionEvidencePort(env);
}

export async function resolveAcquisitionEvidenceBinding(
  env: Env = process.env,
  options: { portFactory?: AcquisitionEvidencePortFactory } = {},
): Promise<AcquisitionEvidencePort | null> {
  if (getBundleDescriptor(resolveBundleId(env)).capabilities.data !== "postgres") return null;
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) return null;
  const factory = options.portFactory ?? createDefault;
  if (options.portFactory) return factory({ connectionString });
  let current = bindings.get(connectionString);
  if (!current) { current = Promise.resolve(factory({ connectionString })); bindings.set(connectionString, current); }
  return current;
}

export async function closeAcquisitionEvidenceBindings(): Promise<void> {
  const current = [...bindings.values()]; bindings.clear();
  await Promise.all(current.map(async (binding) => (await binding).close()));
}
