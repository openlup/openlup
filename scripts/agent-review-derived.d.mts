/** Only facts validated by the existing JSON envelope reader are exposed here. */
export interface InventoryEnvelope {
  value: {
    current: Record<string, unknown>;
    historical: unknown;
  };
  before: string;
  after: string;
}

export const INVENTORY_PATH: string;
export const MIGRATION_REGISTRIES: string[];
export function inventoryEnvelope(source: string): InventoryEnvelope;
export function inventoryOnlyCurrent(base: string, left: string, right: string, committed: string): boolean;
export function migrationRegistryUnion(
  path: string,
  baseSource: string,
  leftSource: string,
  rightSource: string,
  inventorySource?: string,
): string;
