import { describe, expect, it } from "vitest";
import {
  assertMigrationLockSafety,
  evaluateMigrationLockSafety,
  HOT_PRODUCTION_TABLES,
} from "./lock-safety.ts";
import { isExpandOnlyPlatformForward } from "./sql-tokenizer.ts";

describe("transaction-aware SQL lock-safety checks", () => {
  it("defines the exact hot production tables set", () => {
    expect([...HOT_PRODUCTION_TABLES].sort()).toEqual([
      "commerce_orders",
      "fulfillment_shipments",
      "outbox_events",
      "subscriptions",
    ]);
  });

  describe("valid transaction-safe migrations on hot tables", () => {
    it.each([
      [
        "partial index with SET LOCAL lock_timeout (no CONCURRENTLY required)",
        `SET LOCAL lock_timeout = '5s';
CREATE INDEX idx_commerce_orders_pending_note
  ON public.commerce_orders (created_at)
  WHERE status = 'pending';
`,
      ],
      [
        "full index with SET LOCAL lock_timeout and -- lock-safety annotation",
        `SET LOCAL lock_timeout = '5s';
-- lock-safety: table slice verified small; bounded by 5s lock timeout
CREATE INDEX idx_outbox_events_lookup
  ON public.outbox_events (aggregate_type, aggregate_id);
`,
      ],
      [
        "unique partial index with SET lock_timeout TO syntax",
        `SET lock_timeout TO '3s';
CREATE UNIQUE INDEX idx_fulfillment_shipments_ext_ref
  ON public.fulfillment_shipments (order_id)
  WHERE order_id IS NOT NULL;
`,
      ],
      [
        "ADD COLUMN nullable with SET LOCAL lock_timeout",
        `SET LOCAL lock_timeout = '5s';
ALTER TABLE public.subscriptions ADD COLUMN pause_note text;
`,
      ],
      [
        "ADD COLUMN NOT NULL DEFAULT with SET LOCAL lock_timeout",
        `SET LOCAL lock_timeout = '5s';
ALTER TABLE public.commerce_orders ADD COLUMN priority_band text NOT NULL DEFAULT 'standard';
`,
      ],
      [
        "ADD CONSTRAINT CHECK NOT VALID with SET LOCAL lock_timeout",
        `SET LOCAL lock_timeout = '5s';
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_pause_note_check CHECK (pause_note IS NULL OR length(pause_note) <= 200) NOT VALID;
`,
      ],
      [
        "ADD CONSTRAINT FOREIGN KEY NOT VALID with SET LOCAL lock_timeout",
        `SET LOCAL lock_timeout = '5s';
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_parent_fkey FOREIGN KEY (parent_id) REFERENCES public.commerce_orders(id) NOT VALID;
`,
      ],
      [
        "ADD CONSTRAINT CHECK without NOT VALID when justified by -- lock-safety comment",
        `SET LOCAL lock_timeout = '5s';
-- lock-safety: newly populated column checked during maintenance window
ALTER TABLE public.fulfillment_shipments
  ADD CONSTRAINT shipments_kind_check CHECK (kind IN ('standard', 'express'));
`,
      ],
      [
        "nullable column with nested CHECK (... IS NOT NULL) inside parentheses",
        `SET LOCAL lock_timeout = '5s';
ALTER TABLE public.commerce_orders
  ADD COLUMN metadata_tag text CHECK (metadata_tag IS NOT NULL);
`,
      ],
      [
        "unrestricted DDL on non-hot tables without lock_timeout or WHERE",
        `ALTER TABLE public.price_lists ADD COLUMN label text NOT NULL;
ALTER TABLE public.price_lists ADD CONSTRAINT price_lists_label_check CHECK (label <> '');
CREATE INDEX idx_price_lists_label ON public.price_lists (label);
`,
      ],
      [
        "hot-table DDL text inside comments, string literals, or dollar-quoted bodies",
        `-- ALTER TABLE public.commerce_orders ADD COLUMN bad text NOT NULL;
/* CREATE INDEX idx_bad ON public.subscriptions (id); */
CREATE FUNCTION public.example_note() RETURNS text LANGUAGE sql AS $$
  SELECT 'ALTER TABLE public.outbox_events ADD COLUMN x text NOT NULL;';
$$;
`,
      ],
      [
        "non-public schema table with same name as hot table",
        `ALTER TABLE archive.commerce_orders ADD COLUMN archived_reason text NOT NULL;
CREATE INDEX idx_archive_orders ON archive.commerce_orders (id);
`,
      ],
    ])("admits %s", (_label, sql) => {
      expect(evaluateMigrationLockSafety(sql, "db/platform/migrations/20990101000000_valid.sql")).toEqual([]);
      expect(() => assertMigrationLockSafety(sql, "db/platform/migrations/20990101000000_valid.sql")).not.toThrow();
    });

    it("admits SET LOCAL lock_timeout in expand-only forward classification", () => {
      const sql = `SET LOCAL lock_timeout = '5s';
ALTER TABLE public.commerce_orders ADD COLUMN tracking_note text;
CREATE INDEX idx_commerce_orders_tracking_note ON public.commerce_orders (tracking_note) WHERE tracking_note IS NOT NULL;
`;
      expect(isExpandOnlyPlatformForward(sql)).toBe(true);
      expect(() => assertMigrationLockSafety(sql)).not.toThrow();
    });
  });

  describe("refusals on unsafe hot-table DDL", () => {
    it.each([...HOT_PRODUCTION_TABLES])(
      "refuses ADD COLUMN NOT NULL without DEFAULT on hot table %s even with lock_timeout and annotation",
      table => {
        const sql = `SET LOCAL lock_timeout = '5s';
-- lock-safety: cannot bypass NOT NULL without DEFAULT
ALTER TABLE public.${table} ADD COLUMN required_code text NOT NULL;
`;
        const violations = evaluateMigrationLockSafety(sql, "20990101000000_bad.sql");
        expect(violations.map(v => v.rule)).toEqual(["hot_table_add_column_not_null_without_default"]);
        expect(() => assertMigrationLockSafety(sql, "20990101000000_bad.sql")).toThrow(
          new RegExp(`lock-safety: ALTER TABLE public\\.${table} ADD COLUMN required_code NOT NULL without DEFAULT`),
        );
      },
    );

    it("catches ADD COLUMN NOT NULL without DEFAULT in a multi-action ALTER TABLE and without optional COLUMN keyword", () => {
      const sql = `SET LOCAL lock_timeout = '5s';
ALTER TABLE "public"."subscriptions"
  ADD COLUMN safe_note text,
  ADD unsafe_flag boolean NOT NULL;
`;
      const violations = evaluateMigrationLockSafety(sql);
      expect(violations.map(v => v.rule)).toEqual(["hot_table_add_column_not_null_without_default"]);
      expect(violations[0]!.message).toContain("ADD COLUMN unsafe_flag NOT NULL without DEFAULT");
    });

    it.each([
      [
        "CHECK constraint without NOT VALID",
        `SET LOCAL lock_timeout = '5s';
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT orders_total_positive CHECK (total_amount_minor >= 0);
`,
        "CHECK",
      ],
      [
        "FOREIGN KEY constraint without NOT VALID",
        `SET LOCAL lock_timeout = '5s';
ALTER TABLE public.fulfillment_shipments
  ADD CONSTRAINT shipments_order_fk FOREIGN KEY (order_id) REFERENCES public.commerce_orders(id);
`,
        "FOREIGN KEY",
      ],
      [
        "unnamed CHECK constraint without NOT VALID",
        `SET LOCAL lock_timeout = '5s';
ALTER TABLE outbox_events ADD CHECK (attempts >= 0);
`,
        "CHECK",
      ],
      [
        "bare -- lock-safety: comment with no reason",
        `SET LOCAL lock_timeout = '5s';
-- lock-safety:
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_cadence_check CHECK (cadence_days > 0);
`,
        "CHECK",
      ],
    ])("refuses %s", (_label, sql, kind) => {
      const violations = evaluateMigrationLockSafety(sql);
      expect(violations.map(v => v.rule)).toEqual(["hot_table_add_constraint_without_not_valid"]);
      expect(violations[0]!.message).toContain(`(${kind})`);
      expect(violations[0]!.message).toContain("NOT VALID");
    });

    it.each([
      [
        "ALTER TABLE without lock_timeout",
        "ALTER TABLE public.commerce_orders ADD COLUMN note text;\n",
      ],
      [
        "CREATE INDEX without lock_timeout (even with WHERE)",
        "CREATE INDEX idx_orders_note ON public.commerce_orders (note) WHERE note IS NOT NULL;\n",
      ],
      [
        "lock_timeout set AFTER the ALTER TABLE",
        `ALTER TABLE public.subscriptions ADD COLUMN note text;
SET LOCAL lock_timeout = '5s';
`,
      ],
      [
        "lock_timeout set to zero",
        `SET LOCAL lock_timeout = '0';
ALTER TABLE public.outbox_events ADD COLUMN note text;
`,
      ],
      [
        "lock_timeout reset before DDL",
        `SET LOCAL lock_timeout = '5s';
RESET lock_timeout;
ALTER TABLE public.fulfillment_shipments ADD COLUMN note text;
`,
      ],
    ])("refuses missing or inactive lock_timeout: %s", (_label, sql) => {
      const violations = evaluateMigrationLockSafety(sql);
      expect(violations.map(v => v.rule)).toContain("hot_table_missing_lock_timeout");
    });

    it("refuses non-partial CREATE INDEX on a hot table without -- lock-safety annotation", () => {
      const sql = `SET LOCAL lock_timeout = '5s';
CREATE INDEX idx_commerce_orders_client_created
  ON public.commerce_orders (client_id, created_at);
`;
      const violations = evaluateMigrationLockSafety(sql);
      expect(violations.map(v => v.rule)).toEqual(["hot_table_index_without_partial_or_annotation"]);
      expect(violations[0]!.message).toContain("WHERE");
      expect(violations[0]!.message).toContain("-- lock-safety:");
      expect(violations[0]!.message).toContain("do not use CONCURRENTLY");
    });

    it("scopes -- lock-safety annotation to a single statement and refuses the following unannotated index", () => {
      const sql = `SET LOCAL lock_timeout = '5s';
-- lock-safety: first index justified
CREATE INDEX idx_orders_a ON public.commerce_orders (client_id);
CREATE INDEX idx_orders_b ON public.commerce_orders (status);
`;
      const violations = evaluateMigrationLockSafety(sql);
      expect(violations.map(v => v.rule)).toEqual(["hot_table_index_without_partial_or_annotation"]);
    });
  });
});
