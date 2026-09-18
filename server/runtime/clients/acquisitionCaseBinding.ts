import type { AcquisitionCasePort } from "../../domains/clients/acquisitionCasePorts.js";
import {
  createAcquisitionCaseHandlers,
  type AcquisitionCaseHandlers,
} from "../../domains/clients/acquisitionCaseHandlers.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

type Env = Record<string, string | undefined>;
export type AcquisitionCasePortFactory = (
  env: { connectionString: string },
) => AcquisitionCasePort | Promise<AcquisitionCasePort>;

export interface AcquisitionCaseRuntimeBinding {
  handlers: AcquisitionCaseHandlers;
  close(): Promise<void>;
}

const bindings = new Map<string, Promise<AcquisitionCaseRuntimeBinding>>();

async function createDefaultPort(env: { connectionString: string }): Promise<AcquisitionCasePort> {
  const adapter = await import("../../adapters/postgres/clients/acquisitionCaseRoutines.js");
  return adapter.createPostgresAcquisitionCasePort(env);
}

export async function resolveAcquisitionCaseRuntimeBinding(
  env: Env = process.env,
  options: { portFactory?: AcquisitionCasePortFactory } = {},
): Promise<AcquisitionCaseRuntimeBinding | null> {
  if (getBundleDescriptor(resolveBundleId(env)).capabilities.data !== "postgres") return null;
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) return null;
  const factory = options.portFactory ?? createDefaultPort;
  if (options.portFactory) return compose(await factory({ connectionString }));
  let current = bindings.get(connectionString);
  if (!current) {
    current = Promise.resolve(factory({ connectionString })).then(compose);
    bindings.set(connectionString, current);
  }
  return current;
}

export async function closeAcquisitionCaseRuntimeBindings(): Promise<void> {
  const current = [...bindings.values()];
  bindings.clear();
  await Promise.all(current.map(async (binding) => (await binding).close()));
}

function compose(port: AcquisitionCasePort): AcquisitionCaseRuntimeBinding {
  return { handlers: createAcquisitionCaseHandlers(port), close: () => port.close() };
}
