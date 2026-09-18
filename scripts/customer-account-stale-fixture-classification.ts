export type FixtureRoot = {
  id: string;
  shipping_address_id: string | null;
  metadata: unknown;
};

export type FixtureAddress = {
  id: string;
  metadata: unknown;
};

export type ExactAddressOnlyFixture = {
  addressId: string;
  runId: string;
};

export type StaleFixtureInventory = {
  addressOnlyFixtures: ExactAddressOnlyFixture[];
  retainedOrderFixtures: number;
  retainedLegacyOrderFixtures: number;
  retainedLegacyAddressFixtures: number;
};

export function smokeRunId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return text((value as Record<string, unknown>).smokeRunId);
}

/** Classifies stale fixture evidence without mutating any staging row. */
export function classifyStaleCustomerAccountFixtures(input: {
  roots: FixtureRoot[];
  addresses: FixtureAddress[];
}): StaleFixtureInventory {
  const retainedOrderAddresses = new Set<string>();
  let retainedOrderFixtures = 0;
  let retainedLegacyOrderFixtures = 0;
  for (const root of input.roots) {
    const runId = smokeRunId(root.metadata);
    const addressId = text(root.shipping_address_id);
    const orderId = text(root.id);
    if (!runId) {
      if (addressId) retainedOrderAddresses.add(addressId);
      retainedLegacyOrderFixtures += 1;
      continue;
    }
    if (!addressId || !orderId) {
      throw new Error("stale customer fixture order is missing exact ownership evidence");
    }
    retainedOrderAddresses.add(addressId);
    retainedOrderFixtures += 1;
  }

  const addressOnlyFixtures: ExactAddressOnlyFixture[] = [];
  let retainedLegacyAddressFixtures = 0;
  for (const address of input.addresses) {
    const addressId = text(address.id);
    const runId = smokeRunId(address.metadata);
    if (!runId) {
      retainedLegacyAddressFixtures += 1;
      continue;
    }
    if (!addressId) {
      throw new Error("stale customer fixture address is missing exact ownership evidence");
    }
    if (!retainedOrderAddresses.has(addressId)) {
      addressOnlyFixtures.push({ addressId, runId });
    }
  }
  return {
    addressOnlyFixtures,
    retainedOrderFixtures,
    retainedLegacyOrderFixtures,
    retainedLegacyAddressFixtures,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
