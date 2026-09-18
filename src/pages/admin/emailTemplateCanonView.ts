import {
  EMAIL_CANON_REGISTRY,
  EMAIL_CANON_DYNAMIC_PATTERNS,
  findEmailCanonEntry,
  type EmailCanonEntry,
  type EmailCanonDynamicPattern,
  type EmailCanonRecipientKind,
  type EmailCanonRenderer,
} from "@/domains/communications/emailCanon";
import type { AdminEmailTemplate } from "@/domains/communications/contracts";
import { isDbEmailTemplateEditorAllowed } from "@/domains/communications/dbEmailTemplatePolicy";

/**
 * A single row in the admin templates table. The page used to render the
 * `email_templates` DB rows 1:1 — but those are only the `db_template` slugs
 * (~a dozen tester/operational emails). Most customer-facing mail (all
 * commerce, subscription, auth, waitlist/B2B, admin) is rendered from code and
 * never lived in that table, so admins couldn't even see it existed.
 *
 * This view merges the canonical email registry with the DB rows so the table
 * shows the *full* inventory. A backing DB row is editable only when the canon
 * and DB-template policy still authorize the editor surface; terminal no-send
 * history appears read-only. Code-rendered kinds appear read-only as well.
 */
export interface TemplateCanonRow {
  /** Stable React key. */
  key: string;
  /** Slug (or a humanized pattern string for dynamic families). */
  slug: string;
  /** Slug/key used by comms_notification_controls. */
  controlSlug: string;
  /** Display name — DB name when present, else a humanized slug. */
  name: string;
  /** Subject — DB subject when present, else a dash. */
  subject: string;
  /** PL category label derived from the canon recipient kind. */
  category: string;
  /** PL renderer label explaining why the row is / isn't editable here. */
  rendererLabel: string;
  /** Editable here when an allowed DB-template row backs this slug. */
  editable: boolean;
  /** The backing DB row when editable, else null. */
  dbRow: AdminEmailTemplate | null;
}

const CATEGORY_LABELS: Record<EmailCanonRecipientKind, string> = {
  customer: "Klient",
  tester: "Tester",
  lead: "Lead",
  partner: "Partner B2B",
  admin_internal: "Admin / wewn.",
  system: "System",
};

const CATEGORY_ORDER: EmailCanonRecipientKind[] = [
  "customer",
  "tester",
  "lead",
  "partner",
  "admin_internal",
  "system",
];

const RENDERER_LABELS: Record<EmailCanonRenderer, string> = {
  canonical_renderer: "W kodzie",
  db_template: "Edytowalny (DB)",
  legacy_inline: "W kodzie (inline)",
  operational_variant: "Operacyjny",
  provider_external: "Zewnętrzny",
  no_send_decision: "Nieaktywny",
};

function humanizeSlug(slug: string): string {
  const spaced = slug.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A readable, non-regex form of a dynamic pattern for the slug column. */
function patternLabel(entry: EmailCanonDynamicPattern): string {
  switch (entry.id) {
    case "auth-actions":
      return "auth-*";
    case "subscription-payment-failed-attempts":
      return "subscription-payment-failed-N";
    case "survey-notifications":
      return "survey_*_notification";
    default:
      return entry.id;
  }
}

function patternControlSlug(entry: EmailCanonDynamicPattern): string {
  switch (entry.id) {
    case "auth-actions":
      return "auth-*";
    case "subscription-payment-failed-attempts":
      return "subscription-payment-failed-*";
    case "survey-notifications":
      return "survey_*_notification";
    default:
      return entry.id;
  }
}

function categoryRank(kind: EmailCanonRecipientKind): number {
  const idx = CATEGORY_ORDER.indexOf(kind);
  return idx === -1 ? CATEGORY_ORDER.length : idx;
}

function rendererLabelFor(renderer: EmailCanonRenderer | undefined, editable: boolean): string {
  if (renderer) return RENDERER_LABELS[renderer];
  // DB row with no canon entry — it lives in the table, so it's a DB template.
  return editable ? RENDERER_LABELS.db_template : "–";
}

function categoryFor(kind: EmailCanonRecipientKind | undefined): string {
  return kind ? CATEGORY_LABELS[kind] : "Inne";
}

/**
 * Build the merged, sorted view. Editor-eligible DB rows are preserved (so
 * multi-locale rows sharing a slug all stay visible), plus a read-only row for
 * every code-rendered canon kind that has no eligible DB row. A terminal
 * no-send canon entry without DB policy is deliberately not an editor surface.
 */
export function buildTemplateCanonRows(dbRows: AdminEmailTemplate[]): TemplateCanonRow[] {
  const rows: Array<TemplateCanonRow & { rank: number }> = [];
  const editableDbRows = dbRows.filter((row) => isDbEmailTemplateEditorAllowed(row.slug));
  const dbSlugs = new Set(editableDbRows.map((row) => row.slug));

  // 1) Every editor-eligible DB row stays, enriched with canon metadata when available.
  for (const dbRow of editableDbRows) {
    const canon = findEmailCanonEntry(dbRow.slug);
    const kind = canon?.recipientKind;
    rows.push({
      key: `db:${dbRow.id}`,
      slug: dbRow.slug,
      controlSlug: dbRow.slug,
      name: dbRow.name,
      subject: dbRow.subject,
      category: categoryFor(kind),
      rendererLabel: rendererLabelFor(canon?.renderer, true),
      editable: true,
      dbRow,
      rank: categoryRank(kind ?? "tester"),
    });
  }

  // 2) Read-only rows for static canon kinds with no backing DB row.
  for (const entry of EMAIL_CANON_REGISTRY as readonly EmailCanonEntry[]) {
    if (dbSlugs.has(entry.slug)) continue;
    rows.push({
      key: `canon:${entry.slug}`,
      slug: entry.slug,
      controlSlug: entry.slug,
      name: humanizeSlug(entry.slug),
      subject: "–",
      category: categoryFor(entry.recipientKind),
      rendererLabel: rendererLabelFor(entry.renderer, false),
      editable: false,
      dbRow: null,
      rank: categoryRank(entry.recipientKind),
    });
  }

  // 3) Read-only info rows for dynamic pattern families with no matching DB row.
  for (const entry of EMAIL_CANON_DYNAMIC_PATTERNS as readonly EmailCanonDynamicPattern[]) {
    const alreadyShown = editableDbRows.some((row) => entry.pattern.test(row.slug));
    if (alreadyShown) continue;
    const label = patternLabel(entry);
    rows.push({
      key: `pattern:${entry.id}`,
      slug: label,
      controlSlug: patternControlSlug(entry),
      name: humanizeSlug(entry.id),
      subject: "–",
      category: categoryFor(entry.recipientKind),
      rendererLabel: rendererLabelFor(entry.renderer, false),
      editable: false,
      dbRow: null,
      rank: categoryRank(entry.recipientKind),
    });
  }

  rows.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.editable !== b.editable) return a.editable ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });

  return rows.map(({ rank: _rank, ...row }) => row);
}
