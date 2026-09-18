import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronLeft, ChevronRight, Copy, Eye, Pencil, Play, Search, SquarePause } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAdminPromotionCodes, updateAdminPromotionCode } from "@/domains/commerce/adminPromotionCodesClient";
import type { PromotionCodesListRequest, PromotionCodeSummary } from "@/domains/commerce/adminPromotionCodesContracts";
import { getAdminShippingRate, getAdminSubscriptionBand } from "@/domains/commerce/adminPromotionsClient";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

import { PromotionCodeCreateDialog } from "./PromotionCodeCreateDialog";
import { PromotionCodeEditDialog } from "./PromotionCodeEditDialog";
import { PromotionCodePreviewDialog, type PreviewablePromotionCode } from "./PromotionCodePreviewDialog";
import {
  benefitLabel, createIdempotencyKey, formatDateTime, PROMOTION_CODE_PAGE_SIZE,
  representativeContext, scopeLabel, statusLabel, statusTone, type PreviewContextIssue,
} from "./promotionCodeUi";

const statusFilters = [
  "active", "all", "paused", "scheduled", "expired_or_archived",
] as const;

// Whether the Code Center can represent every legacy coupon. "unknown" is a real
// third answer, not a pessimistic default: a caller that treats "not yet checked"
// as "incompatible" renders its legacy fallback on every load and then tears it
// back down, which is the flash PR 2243 made visible on the admin promotions page.
export type LegacyCompatibility = "unknown" | "compatible" | "incompatible";

interface Props {
  accessToken: string;
  onLegacyCompatibilityChange?: (compatibility: LegacyCompatibility) => void;
}

export function PromotionCodeCenter({ accessToken, onLegacyCompatibilityChange }: Props) {
  const { t, i18n } = useTranslation("admin");
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PromotionCodesListRequest["status"]>("active");
  const [scope, setScope] = useState<PromotionCodesListRequest["scope"]>("all");
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const [createOpen, setCreateOpen] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<{ code: PreviewablePromotionCode; activate: boolean } | null>(null);
  const [editing, setEditing] = useState<PreviewablePromotionCode | null>(null);
  const debouncedSearch = useDebouncedValue(search.trim(), 350);
  const mutationKeys = useRef(new Map<string, string>());
  const cursor = cursorStack[cursorStack.length - 1];

  useEffect(() => setCursorStack([undefined]), [debouncedSearch, status, scope]);

  const list = useQuery({
    queryKey: ["admin-promotion-codes", debouncedSearch, status, scope, cursor],
    queryFn: ({ signal }) => getAdminPromotionCodes(accessToken, {
      ...(debouncedSearch ? { q: debouncedSearch } : {}), status, scope, cursor,
      limit: PROMOTION_CODE_PAGE_SIZE,
    }, { signal }),
    retry: false,
  });
  // Momentary: true only while the current query state actively proves coverage.
  // It drops back to false for the duration of any refetch, which is what keeps
  // this component's own "sprawdzanie…" banner honest about re-checking.
  const legacyCompatibilityReady = Boolean(
    list.isSuccess && !list.isFetching && list.data.legacyCompatibility.ready,
  );

  // Sticky: what we have *learned*, for callers that must not act on "not yet
  // known" as if it meant "incompatible". Once the backend has answered, a
  // refetch or a filter change cannot un-answer it — `legacyCompatibility`
  // describes global migration state, not the filtered page. Collapsing back to
  // "unknown" would unmount a caller's legacy fallback on every filter chip.
  // A failed check reports "incompatible": coverage we could not confirm must
  // keep the legacy surface reachable.
  const [legacyCompatibility, setLegacyCompatibility] = useState<LegacyCompatibility>("unknown");
  useEffect(() => {
    if (legacyCompatibilityReady) setLegacyCompatibility("compatible");
    else if (list.isError || (list.data && !list.data.legacyCompatibility.ready)) {
      setLegacyCompatibility("incompatible");
    }
  }, [legacyCompatibilityReady, list.isError, list.data]);

  useEffect(() => {
    onLegacyCompatibilityChange?.(legacyCompatibility);
  }, [legacyCompatibility, onLegacyCompatibilityChange]);
  const band = useQuery({
    queryKey: ["admin-subscription-band"], queryFn: () => getAdminSubscriptionBand(accessToken), retry: false,
  });
  const shipping = useQuery({
    queryKey: ["admin-shipping-rate"], queryFn: () => getAdminShippingRate(accessToken), retry: false,
  });
  const firstPrice = band.data?.entries[0];
  const previewContext = useMemo(() => firstPrice && shipping.data
    ? representativeContext({
        oneTimeMinor: firstPrice.oneTimeMinor,
        subscriptionMinor: firstPrice.subscriptionMinor,
        shippingMinor: shipping.data.shippingFlatMinor,
      })
    : null, [firstPrice, shipping.data]);
  // Which half is missing. An empty band is the one an operator can act on: the
  // active price list has one_time rows but no derivable subscription price, so
  // the discounts editor - not a refresh - is the way out.
  const contextIssue: PreviewContextIssue = band.isError ? "band_error"
    : shipping.isError ? "shipping_error"
    : band.isSuccess && band.data.entries.length === 0 ? "band_empty"
    : null;

  const statusMutation = useMutation({
    mutationFn: async ({ code, nextStatus }: { code: PromotionCodeSummary; nextStatus: "paused" | "archived" }) => {
      const key = `${code.id}:${code.revision}:${nextStatus}`;
      const idempotencyKey = mutationKeys.current.get(key) ?? createIdempotencyKey();
      mutationKeys.current.set(key, idempotencyKey);
      return updateAdminPromotionCode(accessToken, {
        id: code.id, expectedRevision: code.revision, updates: { status: nextStatus }, idempotencyKey,
      });
    },
    onSuccess: async () => {
      mutationKeys.current.clear();
      toast.success(t("admin:adminPromotionCodes.toast.statusUpdated"));
      await queryClient.invalidateQueries({ queryKey: ["admin-promotion-codes"] });
    },
    onError: async (error) => {
      if (errorStatus(error) === 409) {
        toast.error(t("admin:adminPromotionCodes.toast.conflict"));
        await queryClient.invalidateQueries({ queryKey: ["admin-promotion-codes"] });
      } else toast.error(t("admin:adminPromotionCodes.toast.statusError"));
    },
  });

  const codes = list.data?.codes ?? [];
  const mutationsEnabled = list.data?.capabilities.mutationsEnabled === true;
  const filtered = Boolean(debouncedSearch || status !== "active" || scope !== "all");

  return (
    <section className="rounded-card border border-warm-sand bg-white p-4 sm:p-5" aria-labelledby="promotion-code-center-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="promotion-code-center-title" className="font-display text-lg font-semibold text-teal-dark">{t("admin:adminPromotionCodes.title")}</h2>
          <p className="mt-1 text-xs-plus text-text-muted">{t("admin:adminPromotionCodes.subtitle")}</p>
        </div>
        <Button type="button" disabled={!mutationsEnabled} onClick={() => setCreateOpen(true)}>{t("admin:adminPromotionCodes.generate")}</Button>
      </div>

      {!legacyCompatibilityReady && (
        <div className="mt-4 rounded-xl border border-warm-amber/40 bg-warm-amber/10 px-4 py-3 text-xs-plus text-teal-dark" role="status">
          {list.isError
            ? t("admin:adminPromotionCodes.compatibility.unavailable")
            : list.data && !list.data.legacyCompatibility.ready
              ? t("admin:adminPromotionCodes.compatibility.incomplete", {
                  unprojected: list.data.legacyCompatibility.unprojectedCount,
                  collisions: list.data.legacyCompatibility.collisionGroupCount,
                })
              : t("admin:adminPromotionCodes.compatibility.checking")}
        </div>
      )}

      {list.isSuccess && !mutationsEnabled && (
        <div className="mt-4 rounded-xl border border-warm-sand bg-offwhite px-4 py-3 text-xs-plus text-text-muted" role="status">
          {t("admin:adminPromotionCodes.mutationsDisabled")}
        </div>
      )}

      <div className="mt-5 grid gap-3">
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t("admin:adminPromotionCodes.statusFilterLabel")}>
          {statusFilters.map((value) => (
            <button key={value} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}
              className={`focus-ring whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${status === value ? "bg-teal text-void" : "bg-offwhite text-text-muted hover:text-teal-dark"}`}>
              {t(`admin:adminPromotionCodes.statusFilters.${value}`)}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_15rem]">
          <label className="relative">
            <span className="sr-only">{t("admin:adminPromotionCodes.searchLabel")}</span>
            <Search aria-hidden="true" className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("admin:adminPromotionCodes.searchPlaceholder")} className="border-warm-sand bg-offwhite pl-9" />
          </label>
          <Select value={scope} onValueChange={(value) => setScope(value as PromotionCodesListRequest["scope"])}>
            <SelectTrigger aria-label={t("admin:adminPromotionCodes.scopeFilterLabel")} className="border-warm-sand bg-offwhite"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin:adminPromotionCodes.scopeFilters.all")}</SelectItem><SelectItem value="one_time">{t("admin:adminPromotionCodes.scopeFilters.one_time")}</SelectItem>
              <SelectItem value="subscription_initial">{t("admin:adminPromotionCodes.scopeFilters.subscription_initial")}</SelectItem><SelectItem value="both">{t("admin:adminPromotionCodes.scopeFilters.both")}</SelectItem>
              <SelectItem value="shipping">{t("admin:adminPromotionCodes.scopeFilters.shipping")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">{list.isFetching ? t("admin:adminPromotionCodes.live.updating") : t("admin:adminPromotionCodes.live.shown", { count: codes.length })}</p>
      <div className="mt-4 -mx-4 overflow-x-auto sm:mx-0 sm:rounded-xl sm:border sm:border-warm-sand">
        <Table className="min-w-[1040px]">
          <TableHeader><TableRow className="border-warm-sand hover:bg-transparent">
            <TableHead>{t("admin:adminPromotionCodes.table.code")}</TableHead><TableHead>{t("admin:adminPromotionCodes.table.benefit")}</TableHead><TableHead>{t("admin:adminPromotionCodes.table.scope")}</TableHead>
            <TableHead>{t("admin:adminPromotionCodes.table.status")}</TableHead><TableHead>{t("admin:adminPromotionCodes.table.usage")}</TableHead><TableHead className="text-right">{t("admin:adminPromotionCodes.table.actions")}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {list.isLoading ? <StateRow>{t("admin:adminPromotionCodes.table.loading")}</StateRow>
              : list.isError ? <StateRow error>{t("admin:adminPromotionCodes.table.error")}</StateRow>
              : codes.length === 0 ? <StateRow>{filtered ? t("admin:adminPromotionCodes.table.emptyFiltered") : t("admin:adminPromotionCodes.table.emptyActive")}</StateRow>
              : codes.map((code) => <CodeRow key={code.id} code={code} busy={statusMutation.isPending} mutationsEnabled={mutationsEnabled}
                  locale={i18n.language}
                  onPreview={() => setPreviewTarget({ code, activate: false })}
                  onEdit={() => setEditing(code)}
                  onActivate={() => setPreviewTarget({ code, activate: true })}
                  onStatus={(nextStatus) => statusMutation.mutate({ code, nextStatus })} />)}
          </TableBody>
        </Table>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-sm text-text-muted">{t("admin:adminPromotionCodes.pagination.page", { page: cursorStack.length })}</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={cursorStack.length === 1 || list.isFetching} onClick={() => setCursorStack((value) => value.slice(0, -1))}>
            <ChevronLeft aria-hidden="true" className="size-4" /> {t("admin:adminPromotionCodes.pagination.previous")}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!list.data?.nextCursor || list.isFetching} onClick={() => list.data?.nextCursor && setCursorStack((value) => [...value, list.data!.nextCursor!])}>
            {t("admin:adminPromotionCodes.pagination.next")} <ChevronRight aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>

      {mutationsEnabled && <PromotionCodeCreateDialog open={createOpen} accessToken={accessToken} context={previewContext} contextIssue={contextIssue} onClose={() => setCreateOpen(false)} onCreated={(code) => { setStatus("all"); setSearch(code); setCursorStack([undefined]); queryClient.invalidateQueries({ queryKey: ["admin-promotion-codes"] }); }} />}
      <PromotionCodePreviewDialog accessToken={accessToken} code={previewTarget?.code ?? null} context={previewContext} contextIssue={contextIssue} activationRequested={previewTarget?.activate} onClose={() => setPreviewTarget(null)} />
      {mutationsEnabled && <PromotionCodeEditDialog accessToken={accessToken} code={editing} context={previewContext} onClose={() => setEditing(null)} />}
    </section>
  );
}

function CodeRow({ code, busy, mutationsEnabled, locale, onPreview, onEdit, onActivate, onStatus }: { code: PromotionCodeSummary; busy: boolean; mutationsEnabled: boolean; locale: string; onPreview: () => void; onEdit: () => void; onActivate: () => void; onStatus: (status: "paused" | "archived") => void }) {
  const { t } = useTranslation("admin");
  const infinity = "∞";
  const copy = async () => { try { await navigator.clipboard.writeText(code.code); toast.success(t("admin:adminPromotionCodes.toast.copied")); } catch { toast.error(t("admin:adminPromotionCodes.toast.copyError")); } };
  return <TableRow className="border-warm-sand"><TableCell><div className="font-mono font-semibold text-teal-dark">{code.code}</div><div className="text-xs text-text-muted">{code.name}</div></TableCell>
    <TableCell>{code.benefits.map((benefit) => <div key={benefit.lane} className="text-xs-plus">{benefitLabel(benefit, t, locale)}</div>)}</TableCell>
    <TableCell className="text-xs-plus text-text-muted">{scopeLabel(code.scopes, t)}</TableCell>
    <TableCell><span className={`rounded-full px-2 py-1 text-xxs font-semibold uppercase ${statusTone(code.effectiveStatus)}`}>{statusLabel(code.effectiveStatus, t)}</span><div className="mt-1 text-xxs text-text-muted">{formatDateTime(code.validFrom, locale, t("admin:adminPromotionCodes.labels.noExpiry"))} — {formatDateTime(code.validTo, locale, t("admin:adminPromotionCodes.labels.noExpiry"))}</div></TableCell>
    <TableCell className="text-xs-plus"><div>{t("admin:adminPromotionCodes.table.redeemed", { redeemed: code.redeemedCount, limit: code.redemptionLimitGlobal ?? infinity })}</div><div className="text-text-muted">{t("admin:adminPromotionCodes.table.reservations", { reserved: code.reservedCount, remaining: code.remainingCount ?? infinity })}</div><div className="text-text-muted">{t("admin:adminPromotionCodes.table.customerLimit", { limit: code.redemptionLimitPerCustomer ?? infinity })}</div></TableCell>
    <TableCell><div className="flex justify-end gap-1"><IconAction label={t("admin:adminPromotionCodes.actions.copy", { code: code.code })} onClick={copy}><Copy /></IconAction><IconAction label={t("admin:adminPromotionCodes.actions.preview", { code: code.code })} onClick={onPreview}><Eye /></IconAction>{mutationsEnabled && <><IconAction label={t("admin:adminPromotionCodes.actions.edit", { code: code.code })} onClick={onEdit}><Pencil /></IconAction>
      {code.status === "active" ? <IconAction label={t("admin:adminPromotionCodes.actions.pause", { code: code.code })} disabled={busy} onClick={() => onStatus("paused")}><SquarePause /></IconAction> : <IconAction label={t("admin:adminPromotionCodes.actions.activate", { code: code.code })} disabled={busy} onClick={onActivate}><Play /></IconAction>}
      {code.status !== "archived" && <IconAction label={t("admin:adminPromotionCodes.actions.archive", { code: code.code })} disabled={busy} onClick={() => onStatus("archived")}><Archive /></IconAction>}</>}</div></TableCell></TableRow>;
}

function IconAction({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) { return <button type="button" aria-label={label} title={label} className="focus-ring rounded-control p-2 text-text-muted hover:bg-offwhite hover:text-teal-dark disabled:opacity-40" {...props}>{<span className="[&>svg]:size-4">{children}</span>}</button>; }
function StateRow({ children, error = false }: { children: React.ReactNode; error?: boolean }) { return <TableRow><TableCell colSpan={6} className={`py-12 text-center ${error ? "text-destructive" : "text-text-muted"}`}>{children}</TableCell></TableRow>; }
function errorStatus(error: unknown): unknown { return typeof error === "object" && error && "status" in error ? error.status : null; }
