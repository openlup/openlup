import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CustomerSubscriptionActionRequest } from "../../../src/domains/customers/selfServiceContracts.js";
import { createSupabaseCustomerSelfServicePort } from "./customerSelfService.js";
import type { SubscriptionRepricer } from "./subscriptionEditReprice.js";

const SUB = "5b000000-0000-0000-0000-0000000000c3";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "user-1";

function rpcOk() {
  return {
    data: {
      contractVersion: "customer.self_service.v1",
      subscriptionAction: {
        subscriptionId: SUB,
        action: "set_portion_mode",
        status: "applied",
        subscriptionStatus: "active",
        nextCycleAt: null,
        templateVersion: 2,
        eventId: "11110000-0000-0000-0000-000000000001",
      },
    },
    error: null,
  };
}

// Regression for the account E2E audit: a pre-RPC reprice failure (e.g. a plan-length
// resize on a subscription without a daily kcal target) must surface as an actionable
// 4xx the UI can show, not bubble out as an opaque 503. It must also fail closed without
// ever reaching the RPC.
describe("createSupabaseCustomerSelfServicePort.applyAction reprice failure", () => {
  it("maps a reprice failure to BAD_REQUEST and never calls the RPC", async () => {
    const rpc = vi.fn();
    const port = createSupabaseCustomerSelfServicePort({
      customerClient: {} as never,
      serviceClient: { rpc } as never,
      subscriptionRepricer: {
        repriceForEdit: vi.fn(),
        repriceRecipeSet: vi
          .fn()
          .mockRejectedValue(new Error("subscription_reprice_missing_daily_kcal")),
      } as never,
    });

    await expect(
      port.applyAction("user-1", {
        action: "update_plan_length",
        subscriptionId: "11111111-1111-1111-1111-111111111111",
        idempotencyKey: "idem-pl1",
        planDays: 28,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "plan_length_unavailable" });

    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("supabaseCustomerSelfServicePort.applyAction routing", () => {
  it("rejects raw generic bundle actions before the RPC while the rollout flag is off", async () => {
    const rpc = vi.fn(async () => rpcOk());
    const port = createSupabaseCustomerSelfServicePort({
      customerClient: {} as unknown as SupabaseClient,
      serviceClient: { rpc } as unknown as SupabaseClient,
      subscriptionRepricer: {
        repriceForEdit: vi.fn(async () => null),
        repriceRecipeSet: vi.fn(async () => null),
      } as unknown as SubscriptionRepricer,
    });

    await expect(port.applyAction("user-1", {
      action: "resize_bundle",
      idempotencyKey: "generic-resize-off",
      subscriptionId: SUB,
      resizeLever: { kind: "planLength", value: 14 },
      compositionConstraint: { kind: "feeding_days", value: 14, dailyKcalOverride: 300 },
      acceptedQuoteHash: "a".repeat(64),
    } as CustomerSubscriptionActionRequest)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "generic_bundle_actions_disabled",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("routes set_portion_mode through repriceRecipeSet and injects recipeLines into the RPC payload", async () => {
    const rpc = vi.fn(async () => rpcOk());
    const repriceRecipeSet = vi.fn(async () => ({
      recipeLines: [{ variantId: "v1", qty: 7, quoteLine: { sku: "LAMB" } }],
      addonLines: [],
      expectedTemplateVersion: 2,
      quoteHash: "a".repeat(64),
    }));
    const repricer = {
      repriceForEdit: vi.fn(async () => null),
      repriceRecipeSet,
    } as unknown as SubscriptionRepricer;

    const port = createSupabaseCustomerSelfServicePort({
      customerClient: {} as unknown as SupabaseClient,
      serviceClient: { rpc } as unknown as SupabaseClient,
      subscriptionRepricer: repricer,
    });

    await port.applyAction("user-1", {
      action: "set_portion_mode",
      idempotencyKey: "idem-set-portion-1",
      subscriptionId: SUB,
      portionMode: "topper",
      acceptedQuoteHash: "a".repeat(64),
    } as CustomerSubscriptionActionRequest);

    expect(repriceRecipeSet).toHaveBeenCalledWith(
      expect.objectContaining({ action: "set_portion_mode", subscriptionId: SUB }),
    );
    expect(rpc).toHaveBeenCalledWith(
      "customer_self_service_apply_subscription_action",
      expect.objectContaining({
        p_action: "set_portion_mode",
        p_payload: expect.objectContaining({
          recipeLines: [{ variantId: "v1", qty: 7, quoteLine: { sku: "LAMB" } }],
          expectedTemplateVersion: 2,
          acceptedQuoteHash: "a".repeat(64),
        }),
      }),
    );
  });

  it("maps legacy resize edits to generic resize_bundle while the rollout flag is on", async () => {
    const rpc = vi.fn(async () => rpcOk());
    const compositionConstraint = { kind: "feeding_days", value: 14, dailyKcalOverride: 300 };
    const repriceRecipeSet = vi.fn(async () => ({
      recipeLines: [{ variantId: "v1", qty: 4, quoteLine: { sku: "LAMB" } }],
      addonLines: [],
      rewriteAddonLines: false,
      compositionConstraint,
      expectedTemplateVersion: 3,
      quoteHash: "c".repeat(64),
    }));
    const port = createSupabaseCustomerSelfServicePort({
      customerClient: {} as unknown as SupabaseClient,
      serviceClient: { rpc } as unknown as SupabaseClient,
      subscriptionRepricer: {
        repriceForEdit: vi.fn(async () => null),
        repriceRecipeSet,
      } as unknown as SubscriptionRepricer,
      genericBundleActionsEnabled: true,
    });

    await port.applyAction("user-1", {
      action: "update_plan_length",
      idempotencyKey: "legacy-plan-generic",
      subscriptionId: SUB,
      planDays: 14,
      acceptedQuoteHash: "c".repeat(64),
    } as CustomerSubscriptionActionRequest);

    expect(repriceRecipeSet).toHaveBeenCalledWith({
      subscriptionId: SUB,
      action: "resize_bundle",
      sourceAction: "update_plan_length",
      payload: {
        cadenceDays: 14,
        resizeLever: { kind: "planLength", value: 14 },
        expectedTemplateVersion: undefined,
        acceptedQuoteHash: "c".repeat(64),
      },
    });
    expect(rpc).toHaveBeenCalledWith(
      "customer_self_service_apply_subscription_action",
      expect.objectContaining({
        p_action: "resize_bundle",
        p_payload: expect.objectContaining({
          cadenceDays: 14,
          resizeLever: { kind: "planLength", value: 14 },
          coreLines: [{ variantId: "v1", qty: 4, quoteLine: { sku: "LAMB" } }],
          repricedLines: [],
          compositionConstraint,
          expectedTemplateVersion: 3,
          acceptedQuoteHash: "c".repeat(64),
        }),
      }),
    );
  });

  it("rejects price/content edits before the RPC when the accepted quote hash is missing", async () => {
    const rpc = vi.fn(async () => rpcOk());
    const port = createSupabaseCustomerSelfServicePort({
      customerClient: {} as unknown as SupabaseClient,
      serviceClient: { rpc } as unknown as SupabaseClient,
      subscriptionRepricer: {
        repriceForEdit: vi.fn(async () => null),
        repriceRecipeSet: vi.fn(async () => ({
          recipeLines: [{ variantId: "v1", qty: 7, quoteLine: { sku: "LAMB" } }],
          addonLines: [],
          expectedTemplateVersion: 2,
          quoteHash: "b".repeat(64),
        })),
      } as unknown as SubscriptionRepricer,
    });

    await expect(port.applyAction("user-1", {
      action: "update_recipe_mix",
      idempotencyKey: "idem-recipe-mix-1",
      subscriptionId: SUB,
      recipes: [{ variantId: "11111111-1111-4111-8111-111111111111", qty: 7 }],
    } as CustomerSubscriptionActionRequest)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "subscription_quote_not_accepted",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("createSupabaseCustomerSelfServicePort pet idempotency", () => {
  it("replays customer pet create requests by idempotency key without inserting twice", async () => {
    const { client, state } = createFakeSelfServiceClient();
    const port = createSupabaseCustomerSelfServicePort({
      customerClient: client,
      serviceClient: {} as unknown as SupabaseClient,
    });

    const input = {
      idempotencyKey: "pet-create-1",
      petType: "dog",
      name: "Rex",
      breed: "Labrador",
      ageLabel: "adult",
      weightKg: 12,
    } as const;

    const first = await port.createPet(USER_ID, input);
    const second = await port.createPet(USER_ID, input);

    expect(first?.pet.petId).toBe(second?.pet.petId);
    expect(state.pets).toHaveLength(1);
    expect(state.petInsertCount).toBe(1);
    expect(state.events.filter((event) => event.event_type === "customer.pet_created")).toHaveLength(1);
  });

  it("merges pet metadata on update and preserves the original source marker", async () => {
    const { client, state } = createFakeSelfServiceClient({
      pets: [{
        id: "22222222-2222-4222-8222-222222222222",
        client_id: CLIENT_ID,
        pet_type: "dog",
        name: "Rex",
        breed: "Labrador",
        age_label: "adult",
        weight_kg: 12,
        metadata: {
          source: "hidden_configurator",
          configuratorIntentIdempotencyKey: "cfg-1",
          activityLevel: "medium",
          allergies: ["chicken"],
          photoUrl: "https://example.com/rex.jpg",
        },
        removed_at: null,
        removed_reason: null,
        created_at: "2026-07-01T10:00:00.000Z",
        updated_at: "2026-07-01T10:00:00.000Z",
      }],
    });
    const port = createSupabaseCustomerSelfServicePort({
      customerClient: client,
      serviceClient: {} as unknown as SupabaseClient,
    });

    await port.updatePet(USER_ID, {
      idempotencyKey: "pet-update-1",
      petId: "22222222-2222-4222-8222-222222222222",
      bodyCondition: "ideal",
    });

    expect(state.pets[0]?.metadata).toMatchObject({
      source: "hidden_configurator",
      configuratorIntentIdempotencyKey: "cfg-1",
      activityLevel: "medium",
      allergies: ["chicken"],
      photoUrl: "https://example.com/rex.jpg",
      idempotencyKey: "pet-update-1",
      bodyCondition: "ideal",
    });
  });
});

type Row = Record<string, unknown>;

function createFakeSelfServiceClient(input: { pets?: Row[]; events?: Row[] } = {}) {
  const state = {
    clients: [{
      id: CLIENT_ID,
      auth_user_id: USER_ID,
      email: "buyer@example.com",
      first_name: "Ala",
      last_name: null,
      phone: "+48500100100",
      lifecycle_stage: "customer",
    }],
    pets: [...(input.pets ?? [])],
    events: [...(input.events ?? [])],
    petInsertCount: 0,
  };

  const client = {
    from(table: string) {
      return new FakeQuery(table, state);
    },
  } as unknown as SupabaseClient;

  return { client, state };
}

class FakeQuery {
  private filters: Array<{ column: string; value: unknown }> = [];
  private limitCount: number | null = null;
  private insertPayload: Row | null = null;
  private updatePayload: Row | null = null;

  constructor(
    private readonly table: string,
    private readonly state: ReturnType<typeof createFakeSelfServiceClient>["state"],
  ) {}

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  insert(payload: Row): this {
    this.insertPayload = payload;
    return this;
  }

  update(payload: Row): this {
    this.updatePayload = payload;
    return this;
  }

  async maybeSingle() {
    const rows = this.matchingRows();
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    return this.execute();
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<QueryResult> {
    if (this.table === "customer_account_events" && this.insertPayload) {
      this.state.events.push({
        id: `event-${this.state.events.length + 1}`,
        ...this.insertPayload,
      });
      return { data: null, error: null };
    }

    if (this.table === "pets" && this.insertPayload) {
      const row = {
        id: `pet-${this.state.pets.length + 1}`,
        removed_at: null,
        removed_reason: null,
        created_at: "2026-07-01T10:00:00.000Z",
        ...this.insertPayload,
      };
      this.state.pets.push(row);
      this.state.petInsertCount += 1;
      return { data: row, error: null };
    }

    if (this.table === "pets" && this.updatePayload) {
      const row = this.matchingRows()[0];
      if (!row) return { data: null, error: { message: "not found" } };
      Object.assign(row, this.updatePayload);
      return { data: row, error: null };
    }

    const rows = this.matchingRows();
    return { data: this.limitCount === 1 ? rows.slice(0, 1) : rows, error: null };
  }

  private matchingRows(): Row[] {
    const rows = this.rowsForTable();
    return rows.filter((row) =>
      this.filters.every(({ column, value }) => readColumn(row, column) === value),
    );
  }

  private rowsForTable(): Row[] {
    if (this.table === "clients") return this.state.clients;
    if (this.table === "pets") return this.state.pets;
    if (this.table === "customer_account_events") return this.state.events;
    return [];
  }
}

type QueryResult = { data: unknown; error: unknown };

function readColumn(row: Row, column: string): unknown {
  if (column.startsWith("metadata->>")) {
    const key = column.slice("metadata->>".length);
    const metadata = row.metadata;
    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Row)[key]
      : undefined;
  }
  if (column.startsWith("payload->>")) {
    const key = column.slice("payload->>".length);
    const payload = row.payload;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Row)[key]
      : undefined;
  }
  return row[column];
}
