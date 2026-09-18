import type { AdminBundleWritePort } from "../domains/bundle/adminBundleWritePort.js";

/**
 * The scenario table itself: the nine calls the bundle write port exposes, each
 * paired with the exact arguments the boundary must receive under exactly those
 * names. It lives beside the harness rather than inside it so neither file has to
 * grow past the source-size cap as the surface does.
 *
 * An adapter that renames an argument, drops the mode, defaults an idempotency key
 * or reorders a component's fields fails here, identically, on both chains.
 */

const ACTOR = "11111111-1111-4111-8111-111111111111";
const KEY = "22222222-2222-4222-8222-222222222222";

/** The nine calls, each with the exact arguments the boundary must receive. */
export const BUNDLE_WRITE_SCENARIOS: ReadonlyArray<{
  readonly name: string;
  readonly routine: string;
  readonly invoke: (port: AdminBundleWritePort) => Promise<unknown>;
  readonly args: Record<string, unknown>;
}> = [
  {
    name: "create draft",
    routine: "admin_upsert_bundle_draft",
    invoke: (port) =>
      port.upsertDraft(ACTOR, {
        mode: "commit",
        bundle: { code: "starter-set", title: "Starter set", fulfillmentMode: "virtual" },
      } as never),
    args: {
      p_actor_id: ACTOR,
      p_code: "starter-set",
      p_title: "Starter set",
      p_fulfillment_mode: "virtual",
      p_composition_constraint: null,
      p_metadata: null,
      p_clone_from_code: null,
      p_mode: "commit",
      p_idempotency_key: null,
    },
  },
  {
    name: "update draft (partial, replayed through the same boundary)",
    routine: "admin_upsert_bundle_draft",
    invoke: (port) =>
      port.updateDraft(ACTOR, {
        mode: "commit",
        code: "starter-set",
        updates: { title: "Renamed" },
        idempotencyKey: KEY,
      } as never),
    args: {
      p_actor_id: ACTOR,
      p_code: "starter-set",
      p_title: "Renamed",
      p_fulfillment_mode: null,
      p_composition_constraint: null,
      p_metadata: null,
      p_clone_from_code: null,
      p_mode: "commit",
      p_idempotency_key: KEY,
    },
  },
  {
    name: "clone draft (same routine, source named)",
    routine: "admin_upsert_bundle_draft",
    invoke: (port) =>
      port.cloneDraft(ACTOR, {
        mode: "commit",
        sourceCode: "starter-set",
        code: "starter-set-two",
      } as never),
    args: {
      p_actor_id: ACTOR,
      p_code: "starter-set-two",
      p_title: null,
      p_fulfillment_mode: null,
      p_composition_constraint: null,
      p_metadata: null,
      p_clone_from_code: "starter-set",
      p_mode: "commit",
      p_idempotency_key: null,
    },
  },
  {
    name: "set composition (whole set, snake-cased entries)",
    routine: "admin_set_bundle_composition",
    invoke: (port) =>
      port.setComposition(ACTOR, {
        mode: "commit",
        code: "starter-set",
        components: [
          { sku: "UNIT-A", quantity: 2, isAddon: false, sortOrder: 0 },
          { sku: "UNIT-B", quantity: 1, isAddon: true, sortOrder: 1 },
        ],
      } as never),
    args: {
      p_actor_id: ACTOR,
      p_code: "starter-set",
      p_components: [
        { sku: "UNIT-A", quantity: 2, is_addon: false, sort_order: 0 },
        { sku: "UNIT-B", quantity: 1, is_addon: true, sort_order: 1 },
      ],
      p_mode: "commit",
      p_idempotency_key: null,
    },
  },
  {
    name: "set target price (dry run stays a dry run)",
    routine: "admin_set_bundle_target_price",
    invoke: (port) =>
      port.setTargetPrice(ACTOR, {
        mode: "dry_run",
        code: "starter-set",
        price: {
          mode: "one_time",
          targetPriceMinor: 4900,
          currency: "EUR",
          amountKind: "gross",
        },
      } as never),
    args: {
      p_actor_id: ACTOR,
      p_code: "starter-set",
      p_price_mode: "one_time",
      p_target_price_minor: 4900,
      p_currency: "EUR",
      p_amount_kind: "gross",
      p_mode: "dry_run",
      p_idempotency_key: null,
    },
  },
  {
    name: "archive",
    routine: "admin_archive_bundle",
    invoke: (port) => port.archive(ACTOR, { mode: "commit", code: "starter-set" } as never),
    args: { p_actor_id: ACTOR, p_code: "starter-set", p_mode: "commit", p_idempotency_key: null },
  },
  {
    name: "restore",
    routine: "admin_restore_bundle",
    invoke: (port) => port.restore(ACTOR, { mode: "commit", code: "starter-set" } as never),
    args: { p_actor_id: ACTOR, p_code: "starter-set", p_mode: "commit", p_idempotency_key: null },
  },
  {
    name: "activate",
    routine: "admin_activate_bundle",
    invoke: (port) => port.activate(ACTOR, { mode: "commit", code: "starter-set" } as never),
    args: { p_actor_id: ACTOR, p_code: "starter-set", p_mode: "commit", p_idempotency_key: null },
  },
  {
    name: "deactivate",
    routine: "admin_deactivate_bundle",
    invoke: (port) => port.deactivate(ACTOR, { mode: "commit", code: "starter-set" } as never),
    args: { p_actor_id: ACTOR, p_code: "starter-set", p_mode: "commit", p_idempotency_key: null },
  },
];
