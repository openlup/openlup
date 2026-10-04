import { describe, expect, it, vi } from "vitest";
import { buildTemplateCanonRows } from "./emailTemplateCanonView";
import type { AdminEmailTemplate } from "@/domains/communications/contracts";

function dbRow(overrides: Partial<AdminEmailTemplate> & { slug: string; id: string }): AdminEmailTemplate {
  return {
    id: overrides.id,
    slug: overrides.slug,
    name: overrides.name ?? overrides.slug,
    subject: overrides.subject ?? "Subject",
    body_html: overrides.body_html ?? "<p>x</p>",
    body_text: overrides.body_text ?? null,
    trigger_type: overrides.trigger_type ?? null,
    sequence_order: overrides.sequence_order ?? null,
    active: overrides.active ?? true,
  };
}

describe("buildTemplateCanonRows", () => {
  it("keeps eligible DB rows editable and suppresses terminal no-send editor debt under an explicit canon", async () => {
    vi.resetModules();
    vi.doMock("@/domains/communications/emailCanon", async () => {
      const actual = await vi.importActual<typeof import("@/domains/communications/emailCanon")>("@/domains/communications/emailCanon");
      const terminal = { ...actual.EMAIL_CANON_REGISTRY[0]!, slug: "synthetic-terminal", renderer: "no_send_decision" as const };
      return { ...actual, EMAIL_CANON_REGISTRY: [...actual.EMAIL_CANON_REGISTRY, terminal],
        findEmailCanonEntry: (slug: string) => slug === terminal.slug ? terminal : actual.findEmailCanonEntry(slug),
      };
    });
    try {
      const { buildTemplateCanonRows: buildSelectedRows } = await import("./emailTemplateCanonView");
    const dbRows = [
      dbRow({ id: "1", slug: "commerce-order-confirmation", name: "Order confirmation" }),
      dbRow({ id: "2", slug: "synthetic-terminal", name: "Synthetic terminal" }),
      dbRow({ id: "3", slug: "totally-custom", name: "Custom" }),
    ];

    const rows = buildSelectedRows(dbRows);

    // The explicit terminal row is replaced by its read-only canon envelope.
    const editable = rows.filter((r) => r.editable);
    expect(editable).toHaveLength(dbRows.length - 1);
    expect(editable.every((r) => r.dbRow !== null)).toBe(true);

    // Every eligible DB slug remains present and editable.
    for (const db of dbRows.filter((row) => row.slug !== "synthetic-terminal")) {
      const match = rows.find((r) => r.slug === db.slug && r.editable);
      expect(match).toBeDefined();
    }
    expect(rows.find((r) => r.slug === "synthetic-terminal")).toMatchObject({
      editable: false,
      dbRow: null,
      rendererLabel: "Nieaktywny",
    });

    // A DB row with no canon entry still surfaces as a DB template.
    const custom = rows.find((r) => r.slug === "totally-custom");
    expect(custom?.editable).toBe(true);
    expect(custom?.rendererLabel).toBe("Edytowalny (DB)");
    } finally {
      vi.doUnmock("@/domains/communications/emailCanon");
      vi.resetModules();
    }
  });

  it("surfaces code-rendered canon kinds as read-only", () => {
    const rows = buildTemplateCanonRows([]);

    const orderPaid = rows.find((r) => r.slug === "commerce-order-paid");
    expect(orderPaid).toBeDefined();
    expect(orderPaid?.editable).toBe(false);
    expect(orderPaid?.rendererLabel).toBe("W kodzie");
    expect(orderPaid?.dbRow).toBeNull();
    expect(orderPaid?.category).toBe("Klient");
  });

  it("shows the dunning dynamic pattern only when no DB row matches it", () => {
    const withoutMatch = buildTemplateCanonRows([]);
    expect(withoutMatch.some((r) => r.slug === "subscription-payment-failed-N")).toBe(true);

    const withMatch = buildTemplateCanonRows([
      dbRow({ id: "9", slug: "subscription-payment-failed-1", name: "Dunning 1" }),
    ]);
    // The concrete DB row is editable...
    expect(
      withMatch.some((r) => r.slug === "subscription-payment-failed-1" && r.editable),
    ).toBe(true);
    // ...and the generic pattern info row is suppressed to avoid duplication.
    expect(withMatch.some((r) => r.slug === "subscription-payment-failed-N")).toBe(false);
  });
});
