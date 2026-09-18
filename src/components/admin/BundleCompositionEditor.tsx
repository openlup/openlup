import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { getCatalogProduct, listCatalogProducts } from "@/domains/commerce/adminCatalogClient";
import type { BundleComponent } from "@/domains/bundle/adminBundleContracts";
import type { BundleDetailView } from "@/domains/bundle/adminBundleReadContracts";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, CARD_TITLE, FIELD, LABEL } from "./bundleAdminUi";

/**
 * The bill of materials editor.
 *
 * WHOLE-SET SEMANTICS, NOT ROW EDITING. `set-composition` replaces the entire
 * component array atomically, and every rule that governs it is a property of the
 * set rather than of any row: at least one component, at least one non-add-on, no
 * unit twice. So this editor holds the whole array in local state and emits all of
 * it on save. There is no per-row endpoint to call and deliberately so — a partial
 * apply would leave the bill of materials in a state no single request described.
 *
 * Local state is the draft; the server's array is the truth. "Reset" throws the
 * draft away rather than merging, because a merge would have to invent a rule for
 * a row the operator edited and the server also changed.
 *
 * The unit picker is two steps (active product -> its active SKUs) because the
 * catalog list route answers products, not SKUs. Only ACTIVE products and ACTIVE
 * SKUs are offered: a component must itself be sellable (`COMPONENT_NOT_SELLABLE`),
 * so offering a draft unit would be offering a refusal.
 */

/** One row of the shipped admin detail's composition; not separately exported by the contract. */
type BundleDetailComponent = BundleDetailView["components"][number];

function toDraft(components: readonly BundleDetailComponent[]): BundleComponent[] {
  return components.map((component) => ({
    sku: component.sku,
    quantity: component.quantity,
    isAddon: component.isAddon,
    sortOrder: component.sortOrder,
  }));
}

export function BundleCompositionEditor({
  accessToken,
  components,
  pending,
  onSave,
  onDryRun,
}: {
  accessToken: string | undefined;
  components: readonly BundleDetailComponent[];
  pending: boolean;
  onSave: (components: BundleComponent[]) => void;
  onDryRun: (components: BundleComponent[]) => void;
}) {
  const { t } = useTranslation("admin");
  const [draft, setDraft] = useState<BundleComponent[] | null>(null);
  const [productSlug, setProductSlug] = useState("");
  const rows = draft ?? toDraft(components);

  const productsQuery = useQuery({
    queryKey: ["admin-bundles", "catalog-products"],
    enabled: Boolean(accessToken),
    queryFn: () => listCatalogProducts(accessToken as string, { status: "active", limit: 100 }),
  });
  const productQuery = useQuery({
    queryKey: ["admin-bundles", "catalog-product", productSlug],
    enabled: Boolean(accessToken) && productSlug.length > 0,
    queryFn: () => getCatalogProduct(accessToken as string, productSlug),
  });

  const taken = new Set(rows.map((row) => row.sku));
  const offerable = (productQuery.data?.product.skus ?? []).filter(
    (sku) => sku.status === "active" && !taken.has(sku.sku),
  );

  function update(index: number, patch: Partial<BundleComponent>) {
    setDraft(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  }

  function addRow(sku: string) {
    setDraft([...rows, { sku, quantity: 1, isAddon: false, sortOrder: rows.length }]);
  }

  return (
    <section className={CARD}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className={CARD_TITLE}>{t("admin:adminBundles.composition.title")}</h2>
        {draft !== null && (
          <span className="rounded-full bg-warm-amber/20 px-3 py-1 text-xs font-semibold text-warm-amber">
            {t("admin:adminBundles.composition.unsaved")}
          </span>
        )}
      </div>
      <p className="mb-4 text-xs text-text-muted">{t("admin:adminBundles.composition.help")}</p>

      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">{t("admin:adminBundles.composition.empty")}</p>
      ) : (
        <ul className="mb-4 grid gap-2">
          {rows.map((row, index) => (
            <li
              key={row.sku}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-offwhite/15 p-3"
            >
              <span className="flex-1 font-mono text-sm text-teal-dark">{row.sku}</span>

              <div className="flex items-center gap-2">
                <label className={LABEL} htmlFor={`qty-${row.sku}`}>
                  {t("admin:adminBundles.composition.quantity")}
                </label>
                <input
                  id={`qty-${row.sku}`}
                  type="number"
                  min={1}
                  max={999}
                  value={row.quantity}
                  onChange={(event) =>
                    update(index, { quantity: Math.max(1, Number(event.target.value) || 1) })
                  }
                  className="focus-ring w-20 rounded-md border border-offwhite/15 px-2 py-1 text-sm text-teal-dark"
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={row.isAddon}
                  onChange={(event) => update(index, { isAddon: event.target.checked })}
                  className="focus-ring h-4 w-4"
                />
                {t("admin:adminBundles.composition.addon")}
              </label>

              <button
                type="button"
                onClick={() => setDraft(rows.filter((_, position) => position !== index))}
                className="focus-ring rounded-md px-2 py-1 text-xs font-semibold text-destructive hover:bg-offwhite"
              >
                {t("admin:adminBundles.composition.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 rounded-lg border border-dashed border-warm-sand p-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="bundle-product-picker">
            {t("admin:adminBundles.composition.product")}
          </label>
          <select
            id="bundle-product-picker"
            className={FIELD}
            value={productSlug}
            onChange={(event) => setProductSlug(event.target.value)}
          >
            <option value="">{t("admin:adminBundles.composition.productPlaceholder")}</option>
            {(productsQuery.data?.products ?? []).map((product) => (
              <option key={product.slug} value={product.slug}>
                {product.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="bundle-sku-picker">
            {t("admin:adminBundles.composition.sku")}
          </label>
          <select
            id="bundle-sku-picker"
            className={FIELD}
            value=""
            disabled={productSlug.length === 0 || productQuery.isLoading}
            onChange={(event) => event.target.value && addRow(event.target.value)}
          >
            <option value="">
              {productSlug.length === 0
                ? t("admin:adminBundles.composition.skuPlaceholder")
                : offerable.length === 0
                  ? t("admin:adminBundles.composition.skuNone")
                  : t("admin:adminBundles.composition.skuAdd")}
            </option>
            {offerable.map((sku) => (
              <option key={sku.sku} value={sku.sku}>
                {sku.title ?? sku.sku}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {draft !== null && (
          <button type="button" onClick={() => setDraft(null)} className={BTN_SECONDARY}>
            {t("admin:adminBundles.composition.reset")}
          </button>
        )}
        <button
          type="button"
          disabled={pending || rows.length === 0}
          onClick={() => onDryRun(rows)}
          className={BTN_SECONDARY}
        >
          {t("admin:adminBundles.composition.dryRun")}
        </button>
        <button
          type="button"
          disabled={pending || rows.length === 0}
          onClick={() => onSave(rows)}
          className={BTN_PRIMARY}
        >
          {pending ? t("admin:adminBundles.composition.saving") : t("admin:adminBundles.composition.save")}
        </button>
      </div>
    </section>
  );
}
