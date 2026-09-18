import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/lib/authContext";
import { catalogAdminEnabled } from "@/lib/catalogAdminFlag";
import {
  getCatalogSkuPacks,
  getOpenProductReconciliationCount,
} from "@/domains/catalog/adminCatalogPacksClient";
import { CatalogDocumentPanel } from "@/components/admin/CatalogDocumentPanel";

/**
 * Admin "Katalog" — the React (human) head of the catalog.
 *
 * A THIN SHELL. This file owns the flag gate, the operator's bearer token, and
 * the read-only packs projection. The document authority flow — current state,
 * semantic diff, publication — belongs to `CatalogDocumentPanel`, which calls the
 * publication RPCs from the operator's own browser session because they are
 * defended by `catalog_publication_require_human_admin()` reading `auth.uid()`.
 * A service-role route would arrive with `auth.uid() = NULL`, so there is no BFF
 * mutation route here and there must never be one.
 *
 * WHAT USED TO BE HERE AND WHY IT IS GONE. The page previously offered a draft
 * form and a publish-by-slug box driven by `createCatalogDraft` and
 * `activateCatalogProduct`. Both reach retained Wave 3 compatibility routes that
 * authenticate and then refuse with `legacy_catalog_mutation_fenced`, for every
 * caller including a human admin. Neither action could write, and the page's own
 * copy claimed both worked; the copy is rewritten rather than translated.
 *
 * ALL COPY IS TRANSLATED, AND THAT IS MEASURED. `src/pages/admin/**` sits in the
 * `storefront-admin-ui` OSS surface family, whose `country` counter has no slack
 * on this branch, so an inline sentence here is a gate failure rather than a
 * style question. Keys live in `src/i18n/locales/{pl,en}/admin.json`.
 */

/** The projection's source table, named in help copy through interpolation. */
const PACKS_SOURCE_TABLE = "catalog_sku_eans";

export default function CatalogPage() {
  const { t } = useTranslation("admin");
  const { session } = useAuth();
  const accessToken = session?.access_token;

  // Read-only packs (SKU ↔ many EANs) projection + an open-reconciliation badge.
  //
  // Both gate on the flag as well as the token. Hooks cannot be conditional, so
  // these sit above the flag gate below and would otherwise spend two
  // authenticated admin reads on every deployment that hides this surface, only
  // to throw the answers away. `enabled` is the only place a suppressed page can
  // say so; `BundlesPage` states the same clause for the same reason.
  const packsQuery = useQuery({
    queryKey: ["admin-catalog-sku-packs"],
    queryFn: () => getCatalogSkuPacks(accessToken as string),
    enabled: Boolean(accessToken) && catalogAdminEnabled(),
  });
  const reconciliationQuery = useQuery({
    queryKey: ["admin-product-reconciliation-open-count"],
    queryFn: () => getOpenProductReconciliationCount(accessToken as string),
    enabled: Boolean(accessToken) && catalogAdminEnabled(),
  });
  const openReconciliations = reconciliationQuery.data ?? 0;

  if (!catalogAdminEnabled()) {
    return <div className="p-8 text-text-muted">{t("admin:adminCatalog.disabled")}</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="font-display text-[24px] font-bold text-teal-dark">
          {t("admin:adminCatalog.title")}
        </h1>
        <p className="text-sm text-text-muted">{t("admin:adminCatalog.subtitle")}</p>
        <p className="mt-2 text-xs text-text-muted">{t("admin:adminCatalog.retiredNotice")}</p>
      </header>

      {/*
        The panel takes a `string`, reads on mount, and has no token guard of its
        own; the packs queries below gate on `enabled`. `tsconfig.app.json` sets
        `strict: false`, so passing `string | undefined` here type-checks and
        would send `Bearer undefined` on a tokenless render. Withholding the
        panel is the same discipline the packs reads already follow.
      */}
      {accessToken !== undefined && <CatalogDocumentPanel accessToken={accessToken} t={t} />}

      <section className="rounded-2xl border border-warm-sand bg-white p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-display text-[16px] font-semibold text-teal-dark">
            {t("admin:adminCatalog.packs.title")}{" "}
            <span className="text-xs font-normal text-text-muted">
              {t("admin:adminCatalog.packs.readOnly")}
            </span>
          </h2>
          {openReconciliations > 0 && (
            <span
              className="rounded-full bg-warm-amber/20 px-3 py-1 text-xs font-semibold text-warm-amber"
              title={t("admin:adminCatalog.packs.reconciliationTitle")}
            >
              {t("admin:adminCatalog.packs.reconciliation", { value: openReconciliations })}
            </span>
          )}
        </div>
        <p className="mb-4 text-xs text-text-muted">
          {t("admin:adminCatalog.packs.help", { table: PACKS_SOURCE_TABLE })}
        </p>

        {packsQuery.isLoading ? (
          <p className="text-sm text-text-muted">{t("admin:adminCatalog.packs.loading")}</p>
        ) : packsQuery.isError ? (
          <p className="text-sm text-warm-amber">{t("admin:adminCatalog.packs.error")}</p>
        ) : (packsQuery.data?.skus.length ?? 0) === 0 ? (
          <p className="text-sm text-text-muted">{t("admin:adminCatalog.packs.empty")}</p>
        ) : (
          <ul className="space-y-3">
            {packsQuery.data?.skus.map((item) => (
              <li key={item.sku} className="rounded-lg border border-offwhite/15 p-3">
                <div className="font-mono text-sm text-teal-dark">{item.sku}</div>
                <ul className="mt-2 space-y-1">
                  {item.packs.map((pack) => (
                    <li key={pack.ean} className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                      <span className="font-mono text-charcoal">{pack.ean}</span>
                      <span className="rounded bg-offwhite/10 px-1.5 py-0.5">
                        {pack.kind === "collective"
                          ? t("admin:adminCatalog.packs.collective", { quantity: pack.quantity })
                          : t("admin:adminCatalog.packs.unit")}
                      </span>
                      {pack.isPrimary && (
                        <span className="rounded bg-teal/10 px-1.5 py-0.5 text-teal-dark">
                          {t("admin:adminCatalog.packs.primary")}
                        </span>
                      )}
                      <span className="rounded bg-offwhite/10 px-1.5 py-0.5">{pack.source}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
