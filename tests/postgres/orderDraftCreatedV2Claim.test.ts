import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createPostgresOutboxStore } from "@openlup/outbox/postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { installAccountMutations, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { insert } from "./orderMoneyV2Storage.fixture.js";

let store: AccountMutationsStore;
beforeAll(async () => { store = await installAccountMutations("bootstrap"); }, postgresSetupTimeoutMs);
afterAll(() => store?.close(), postgresTeardownTimeoutMs);

it("draft_created_v2_reads_claimed_row", async () => {
  const eventId = randomUUID(), orderId = randomUUID();
  const payload = { orderId, quoteId: randomUUID(), acceptedMoneyDigest: "a".repeat(64), destinationSnapshotRef: randomUUID() };
  const eventType = "commerce.order_draft.created.v2";
  await insert(store.owner, "outbox_events", {
    id: eventId, aggregate_type: "commerce_order", aggregate_id: orderId, event_type: eventType,
    idempotency_key: "draft:" + eventId, payload, error: "fixture-error", metadata: { private: "fixture" },
  });
  const outbox = createPostgresOutboxStore({ query: (sql, values) => store.runtime.query(sql, values ? [...values] : undefined) });
  const claimed = await outbox.claimBatch({
    eventTypes: [eventType], knownEventTypes: [eventType], batchSize: 1, visibilitySeconds: 60, maxAttempts: 3,
  });
  expect(claimed).toHaveLength(1);
  expect(claimed[0]).toMatchObject({ id: eventId, status: "processing", metadata: { claimToken: expect.any(String) } });
  const decoder = fileURLToPath(new URL("../../packages/platform/test/commerce/orderDraftCreatedV2Claim.fixture.ts", import.meta.url));
  const decoded = execFileSync(process.execPath, ["--import", "tsx", decoder], {
    input: JSON.stringify(claimed[0]), encoding: "utf8",
  });
  expect(JSON.parse(decoded)).toStrictEqual({ eventId, ...payload });
});
