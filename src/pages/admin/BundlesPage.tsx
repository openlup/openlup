import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useAuth } from "@/lib/authContext";
import { bundleAdminEnabled } from "@/lib/bundleAdminFlag";
import {
  activateBundle,
  archiveBundle,
  createBundleDraft,
  deactivateBundle,
  getBundle,
  listBundles,
  restoreBundle,
  setBundleComposition,
  setBundleTargetPrice,
  updateBundleDraft,
} from "@/domains/bundle/adminBundleClient";
import type { BundleComponent } from "@/domains/bundle/adminBundleContracts";
import type { ListBundlesRequest } from "@/domains/bundle/adminBundleReadContracts";
import { BundleCompositionEditor } from "@/components/admin/BundleCompositionEditor";
import { BundleDraftForm, type BundleDraftFormValues } from "@/components/admin/BundleDraftForm";
import { BundlePricePreviewCard } from "@/components/admin/BundlePricePreviewCard";
import { BundlePublishBar } from "@/components/admin/BundlePublishBar";
import { BundleStockCard } from "@/components/admin/BundleStockCard";
import {
  bundleDetailKey,
  bundleListKey,
  storedBundleCurrency,
} from "@/components/admin/bundleAdminUi";

/**
 * Admin "Pakiety" — the React (human) head of the agent-operable bundle domain
 * built in program waves A1-A4.
 *
 * A THIN SHELL, like `PromotionsPage`. This file owns three things and no card's
 * business: which bundle is selected, the two queries every card reads from, and
 * the mutations, because a mutation must invalidate caches the cards do not know
 * about. Each card receives data and callbacks and decides nothing about the wire.
 *
 * Like the catalog head, it submits the SAME write contracts the MCP agent head
 * uses — with the two exceptions the agent structurally does not have: activate
 * and deactivate, which are human-only at the handler, at the write routine, and
 * by absence from the generated MCP tools.
 */
/** The list route's own status vocabulary; taken from the contract, never restated. */
type BundleStatusFilter = ListBundlesRequest["status"];

const STATUS_FILTERS: BundleStatusFilter[] = ["all", "draft", "active", "archived"];

export default function BundlesPage() {
  const { t } = useTranslation("admin");
  const { session, role } = useAuth();
  const accessToken = session?.access_token;
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<BundleStatusFilter>("all");

  // Flag as well as token: hooks cannot be conditional, so this is declared above
  // the gate below and would otherwise read on a surface the deployment hides.
  const list = useQuery({
    queryKey: bundleListKey(statusFilter),
    enabled: Boolean(accessToken) && bundleAdminEnabled(),
    retry: false,
    // Pagination is stated rather than defaulted: the request contract's `limit`
    // and `offset` carry server-side defaults, so they are required in its parsed
    // shape, and naming them keeps the page honest that it shows one page.
    queryFn: () =>
      listBundles(accessToken as string, { status: statusFilter, limit: 100, offset: 0 }),
  });

  const detail = useQuery({
    queryKey: bundleDetailKey(selected ?? ""),
    enabled: Boolean(accessToken) && selected !== null,
    retry: false,
    queryFn: () => getBundle(accessToken as string, { code: selected as string }),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["admin-bundles"] });
  }

  /** One mutation shape for every write: toast the outcome, then refetch. */
  function writer<TInput>(
    call: (input: TInput) => Promise<unknown>,
    successKey: string,
    errorKey: string,
  ) {
    return {
      mutationFn: call,
      onSuccess: () => {
        toast.success(t(successKey));
        invalidate();
      },
      onError: () => toast.error(t(errorKey)),
    };
  }

  const create = useMutation(
    writer(
      (values: BundleDraftFormValues) =>
        createBundleDraft(accessToken as string, {
          mode: "commit",
          bundle: { code: values.code as string, title: values.title, fulfillmentMode: "virtual" },
        }),
      "admin:adminBundles.toast.created",
      "admin:adminBundles.toast.createFailed",
    ),
  );

  const update = useMutation(
    writer(
      (values: BundleDraftFormValues) =>
        updateBundleDraft(accessToken as string, {
          mode: "commit",
          code: selected as string,
          updates: { title: values.title },
        }),
      "admin:adminBundles.toast.updated",
      "admin:adminBundles.toast.updateFailed",
    ),
  );

  const composition = useMutation(
    writer(
      ({ components, dryRun }: { components: BundleComponent[]; dryRun: boolean }) =>
        setBundleComposition(accessToken as string, {
          mode: dryRun ? "dry_run" : "commit",
          code: selected as string,
          components,
        }),
      "admin:adminBundles.toast.composed",
      "admin:adminBundles.toast.composeFailed",
    ),
  );

  const price = useMutation(
    writer(
      (input: { targetPriceMinor: number; currency: string }) =>
        setBundleTargetPrice(accessToken as string, {
          mode: "commit",
          code: selected as string,
          price: {
            mode: "any",
            targetPriceMinor: input.targetPriceMinor,
            currency: input.currency,
            amountKind: "gross",
          },
        }),
      "admin:adminBundles.toast.priced",
      "admin:adminBundles.toast.priceFailed",
    ),
  );

  const lifecycle = useMutation(
    writer(
      (action: "activate" | "deactivate" | "archive" | "restore") => {
        const request = { mode: "commit" as const, code: selected as string };
        if (action === "activate") return activateBundle(accessToken as string, request);
        if (action === "deactivate") return deactivateBundle(accessToken as string, request);
        if (action === "archive") return archiveBundle(accessToken as string, request);
        return restoreBundle(accessToken as string, request);
      },
      "admin:adminBundles.toast.lifecycle",
      "admin:adminBundles.toast.lifecycleFailed",
    ),
  );

  if (!bundleAdminEnabled()) {
    return <div className="p-8 text-text-muted">{t("admin:adminBundles.disabled")}</div>;
  }

  const bundle = detail.data?.bundle;
  const activeTargetPrice = bundle?.prices.find((entry) => entry.active);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="font-display text-[24px] font-bold text-teal-dark">
          {t("admin:adminBundles.title")}
        </h1>
        <p className="text-sm text-text-muted">{t("admin:adminBundles.subtitle")}</p>
      </header>

      <section className="rounded-2xl border border-warm-sand bg-white p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-[16px] font-semibold text-teal-dark">
            {t("admin:adminBundles.list.title")}
          </h2>
          <div>
            <label className="sr-only" htmlFor="bundle-status-filter">
              {t("admin:adminBundles.list.filter")}
            </label>
            <select
              id="bundle-status-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as BundleStatusFilter)}
              className="focus-ring rounded-md border border-warm-sand px-2 py-1 text-xs text-teal-dark"
            >
              {STATUS_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {t(`admin:adminBundles.list.status.${value}`)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {list.isLoading ? (
          <p className="text-sm text-text-muted">{t("admin:adminBundles.list.loading")}</p>
        ) : list.isError ? (
          <p className="text-sm text-warm-amber">{t("admin:adminBundles.list.error")}</p>
        ) : (list.data?.bundles.length ?? 0) === 0 ? (
          <p className="text-sm text-text-muted">{t("admin:adminBundles.list.empty")}</p>
        ) : (
          <ul className="grid gap-2">
            {list.data?.bundles.map((summary) => (
              <li key={summary.code}>
                <button
                  type="button"
                  aria-current={selected === summary.code ? "true" : undefined}
                  onClick={() => setSelected(summary.code)}
                  className={`focus-ring flex min-h-[44px] w-full flex-wrap items-center gap-3 rounded-lg border p-3 text-left transition ${
                    selected === summary.code
                      ? "border-teal bg-light-teal/40"
                      : "border-offwhite/15 hover:bg-offwhite/40"
                  }`}
                >
                  <span className="flex-1 text-sm font-semibold text-teal-dark">
                    {summary.title}
                  </span>
                  <span className="font-mono text-xs text-text-muted">{summary.code}</span>
                  <span className="rounded bg-offwhite/20 px-1.5 py-0.5 text-xxs font-bold text-teal-dark">
                    {t(`admin:adminBundles.list.status.${summary.status}`, {
                      defaultValue: summary.status,
                    })}
                  </span>
                  <span className="text-xs text-text-muted">
                    {/* A named interpolation rather than i18next's `count`: `count`
                        switches on plural suffixes, and the unused-key guard reads
                        whole literal keys, so the suffixed forms would scan as
                        unused while the base key scanned as missing. */}
                    {t("admin:adminBundles.list.components", { value: summary.componentCount })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BundleDraftForm
        editingCode={selected ?? undefined}
        initialTitle={bundle?.title}
        pending={create.isPending || update.isPending}
        onSubmit={(values) => (selected ? update.mutate(values) : create.mutate(values))}
      />

      {selected !== null && bundle !== undefined && (
        <>
          <BundleCompositionEditor
            accessToken={accessToken}
            components={bundle.components}
            pending={composition.isPending}
            onSave={(components) => composition.mutate({ components, dryRun: false })}
            onDryRun={(components) => composition.mutate({ components, dryRun: true })}
          />

          <BundlePricePreviewCard
            accessToken={accessToken}
            code={bundle.code}
            storedTargetPriceMinor={activeTargetPrice?.targetPriceMinor}
            storedCurrency={storedBundleCurrency(bundle)}
            savePending={price.isPending}
            onSave={(input) => price.mutate(input)}
          />

          <BundleStockCard
            code={bundle.code}
            status={bundle.status}
            availability={bundle.availability}
          />

          <BundlePublishBar
            status={bundle.status}
            hasActiveTargetPrice={bundle.hasActiveTargetPrice}
            componentCount={bundle.components.length}
            canActivate={role === "admin"}
            pending={lifecycle.isPending}
            onActivate={() => lifecycle.mutate("activate")}
            onDeactivate={() => lifecycle.mutate("deactivate")}
            onArchive={() => lifecycle.mutate("archive")}
            onRestore={() => lifecycle.mutate("restore")}
          />
        </>
      )}
    </div>
  );
}
