import type { InventoryReservationLegacySchemaFallbackConfig } from "../../adapters/managed/commerce/inventoryReservationPort.js";

type InventoryReservationRuntimeEnv = {
  openlup_ENVIRONMENT?: string;
  VERCEL_ENV?: string;
  NODE_ENV?: string;
};

export function readInventoryReservationLegacySchemaFallbackConfig(
  env: InventoryReservationRuntimeEnv = process.env,
): InventoryReservationLegacySchemaFallbackConfig {
  const openlupEnvironment = normalizeEnvValue(env.openlup_ENVIRONMENT);
  const vercelEnvironment = normalizeEnvValue(env.VERCEL_ENV);
  const nodeEnvironment = normalizeEnvValue(env.NODE_ENV);

  return {
    enabled:
      vercelEnvironment === "preview" ||
      openlupEnvironment === "staging" ||
      openlupEnvironment === "development",
    environmentLabel:
      openlupEnvironment || vercelEnvironment || nodeEnvironment || "unknown",
  };
}

function normalizeEnvValue(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}
