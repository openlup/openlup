import type { PartnerAcquisitionPort } from "../../../src/domains/partners/ports.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

type Env = Record<string, string | undefined>;
export type PartnerAcquisitionPortFactory = (
  env: { connectionString: string },
) => PartnerAcquisitionPort | Promise<PartnerAcquisitionPort>;

const bindings = new Map<string, Promise<PartnerAcquisitionPort>>();

async function createDefaultPort(env: { connectionString: string }): Promise<PartnerAcquisitionPort> {
  const adapter = await import("../../adapters/postgres/partners/partnerAcquisitionRoutines.js");
  return adapter.createPostgresPartnerAcquisitionPort(env);
}

export async function resolvePartnerAcquisitionBinding(
  env: Env = process.env,
  options: { portFactory?: PartnerAcquisitionPortFactory } = {},
): Promise<PartnerAcquisitionPort | null> {
  if (getBundleDescriptor(resolveBundleId(env)).capabilities.data !== "postgres") return null;
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) return null;
  const factory = options.portFactory ?? createDefaultPort;
  if (options.portFactory) return factory({ connectionString });
  let current = bindings.get(connectionString);
  if (!current) {
    current = Promise.resolve(factory({ connectionString }));
    bindings.set(connectionString, current);
  }
  return current;
}

export async function closePartnerAcquisitionBindings(): Promise<void> {
  const current = [...bindings.values()];
  bindings.clear();
  await Promise.all(current.map(async (binding) => (await binding).close()));
}
