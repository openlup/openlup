import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createAdminPromotionCode,
  previewAdminPromotionCode,
} from "@/domains/commerce/adminPromotionCodesClient";
import type {
  PromotionCodeCreateRequest,
  PromotionCodePreviewRequest,
  PromotionCodePreviewResponse,
} from "@/domains/commerce/adminPromotionCodesContracts";

import { PromotionCodeBenefitFields, type BenefitFormState } from "./PromotionCodeBenefitFields";
import { PromotionCodePreviewResults } from "./PromotionCodePreviewResults";
import {
  createIdempotencyKey,
  fromDateTimeLocal,
  minimumProductPayableLabel,
  parseMoneyMinor,
  parseOptionalPositiveInteger,
  settlementCurrencySymbol,
  toDateTimeLocal,
  type PreviewContextIssue,
} from "./promotionCodeUi";

interface Props {
  open: boolean;
  accessToken: string;
  context: PromotionCodePreviewRequest["context"] | null;
  /** Which half of the context is missing; `null` keeps the generic sentence. */
  contextIssue?: PreviewContextIssue;
  onClose: () => void;
  onCreated: (code: string) => void;
}

interface FormState extends BenefitFormState {
  name: string;
  description: string;
  codeMode: "automatic" | "manual";
  code: string;
  oneTime: boolean;
  subscription: boolean;
  validFrom: string;
  validTo: string;
  minimumReference: string;
  globalLimit: string;
  customerLimit: string;
  status: "draft" | "active";
}

export function PromotionCodeCreateDialog({ open, accessToken, context, contextIssue = null, onClose, onCreated }: Props) {
  const { t, i18n } = useTranslation("admin");
  const [form, setForm] = useState<FormState>(initialForm);
  const [preview, setPreview] = useState<PromotionCodePreviewResponse | null>(null);
  const idempotencyKey = useRef(createIdempotencyKey());
  const previewKey = JSON.stringify([
    form.productEnabled, form.productKind, form.productValue,
    form.shippingEnabled, form.shippingKind, form.shippingValue,
    form.oneTime, form.subscription, form.minimumReference, context,
  ]);
  const requestKey = JSON.stringify(form);

  useEffect(() => setPreview(null), [previewKey]);
  useEffect(() => { idempotencyKey.current = createIdempotencyKey(); }, [requestKey]);
  useEffect(() => {
    if (!open) return;
    setForm(initialForm());
    setPreview(null);
    idempotencyKey.current = createIdempotencyKey();
  }, [open]);

  const previewMutation = useMutation({
    mutationFn: () => previewAdminPromotionCode(accessToken, buildPreviewRequest(form, context)),
    onSuccess: setPreview,
    onError: () => toast.error(t("admin:adminPromotionCodes.toast.previewValuesError")),
  });

  const createMutation = useMutation({
    mutationFn: () => createAdminPromotionCode(
      accessToken,
      buildCreateRequest(form, context, preview, idempotencyKey.current),
    ),
    onSuccess: (result) => {
      toast.success(t("admin:adminPromotionCodes.toast.created"));
      onCreated(result.code);
      onClose();
    },
    onError: (error) => {
      const status = typeof error === "object" && error && "status" in error ? error.status : null;
      toast.error(status === 409 ? t("admin:adminPromotionCodes.toast.duplicate") : t("admin:adminPromotionCodes.toast.createError"));
    },
  });

  const patch = (next: Partial<FormState>) => setForm((current) => ({ ...current, ...next }));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto border-warm-sand bg-white text-teal-dark sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-semibold">{t("admin:adminPromotionCodes.createDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("admin:adminPromotionCodes.createDialog.description", {
              amount: minimumProductPayableLabel(i18n.language),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("admin:adminPromotionCodes.createDialog.name")}>
              <Input value={form.name} maxLength={120} onChange={(event) => patch({ name: event.target.value })} />
            </Field>
            <Field label={t("admin:adminPromotionCodes.createDialog.code")}>
              <div className="flex gap-2">
                <Select value={form.codeMode} onValueChange={(value) => patch({ codeMode: value as FormState["codeMode"] })}>
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="automatic">{t("admin:adminPromotionCodes.createDialog.automatic")}</SelectItem>
                    <SelectItem value="manual">{t("admin:adminPromotionCodes.createDialog.manual")}</SelectItem>
                  </SelectContent>
                </Select>
                {form.codeMode === "manual" && (
                  <Input
                    aria-label={t("admin:adminPromotionCodes.createDialog.manualLabel")}
                    value={form.code}
                    maxLength={64}
                    placeholder="VIP80"
                    onChange={(event) => patch({ code: event.target.value })}
                  />
                )}
              </div>
            </Field>
          </div>
          <Field label={t("admin:adminPromotionCodes.createDialog.adminDescription")}>
            <Textarea value={form.description} maxLength={500} onChange={(event) => patch({ description: event.target.value })} />
          </Field>

          <PromotionCodeBenefitFields value={form} onChange={(benefits) => patch(benefits)} />

          <fieldset className="grid gap-2 rounded-card border border-warm-sand p-4">
            <legend className="px-1 font-display text-base font-semibold">{t("admin:adminPromotionCodes.createDialog.scopeLegend")}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.oneTime} onChange={(event) => patch({ oneTime: event.target.checked })} className="size-4 accent-teal" />
              {t("admin:adminPromotionCodes.labels.oneTime")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.subscription} onChange={(event) => patch({ subscription: event.target.checked })} className="size-4 accent-teal" />
              {t("admin:adminPromotionCodes.labels.subscription")}
            </label>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t("admin:adminPromotionCodes.createDialog.validFrom")}><Input type="datetime-local" value={form.validFrom} onChange={(event) => patch({ validFrom: event.target.value })} /></Field>
            <Field label={t("admin:adminPromotionCodes.createDialog.validTo")}><Input type="datetime-local" value={form.validTo} onChange={(event) => patch({ validTo: event.target.value })} /></Field>
            <Field label={t("admin:adminPromotionCodes.createDialog.minimum", {
              currency: settlementCurrencySymbol(i18n.language),
            })}><Input type="number" min={0} step="0.01" value={form.minimumReference} onChange={(event) => patch({ minimumReference: event.target.value })} /></Field>
            <Field label={t("admin:adminPromotionCodes.createDialog.globalLimit")}><Input type="number" min={1} value={form.globalLimit} onChange={(event) => patch({ globalLimit: event.target.value })} /></Field>
            <Field label={t("admin:adminPromotionCodes.createDialog.customerLimit")}><Input type="number" min={1} value={form.customerLimit} onChange={(event) => patch({ customerLimit: event.target.value })} /></Field>
            <Field label={t("admin:adminPromotionCodes.createDialog.status")}>
              <Select value={form.status} onValueChange={(value) => patch({ status: value as FormState["status"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="draft">{t("admin:adminPromotionCodes.createDialog.draft")}</SelectItem><SelectItem value="active">{t("admin:adminPromotionCodes.createDialog.active")}</SelectItem></SelectContent>
              </Select>
            </Field>
          </div>

          {preview && <PromotionCodePreviewResults preview={preview} />}
          {!context && <p role="alert" className="text-sm text-destructive">
            {contextIssue === "band_empty" ? t("admin:adminPromotionCodes.createDialog.bandEmpty")
              : contextIssue === "band_error" ? t("admin:adminPromotionCodes.createDialog.bandError")
              : contextIssue === "shipping_error" ? t("admin:adminPromotionCodes.createDialog.shippingError")
              : t("admin:adminPromotionCodes.createDialog.missingContext")}
          </p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t("admin:adminPromotionCodes.createDialog.cancel")}</Button>
          <Button type="button" variant="outline" disabled={!context || previewMutation.isPending || createMutation.isPending} onClick={() => previewMutation.mutate()}>
            {previewMutation.isPending ? t("admin:adminPromotionCodes.createDialog.calculating") : preview ? t("admin:adminPromotionCodes.createDialog.refresh") : t("admin:adminPromotionCodes.createDialog.preview")}
          </Button>
          <Button
            type="button"
            disabled={createMutation.isPending || (form.status === "active" && !preview)}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? t("admin:adminPromotionCodes.createDialog.creating") : t("admin:adminPromotionCodes.createDialog.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function initialForm(): FormState {
  return {
    name: "", description: "", codeMode: "automatic", code: "",
    productEnabled: true, productKind: "target_percentage", productValue: "10",
    shippingEnabled: false, shippingKind: "free_shipping", shippingValue: "10",
    oneTime: true, subscription: true, validFrom: toDateTimeLocal(new Date().toISOString()), validTo: "",
    minimumReference: "0", globalLimit: "", customerLimit: "", status: "draft",
  };
}

function buildPreviewRequest(form: FormState, context: PromotionCodePreviewRequest["context"] | null): PromotionCodePreviewRequest {
  if (!context) throw new Error("preview_context_unavailable");
  return { benefits: buildBenefits(form), scopes: buildScopes(form), promotionEngineVersion: "promotion-engine.v2", minimumReferenceMinor: parseMoneyMinor(form.minimumReference, { allowZero: true }), context };
}

function buildCreateRequest(form: FormState, context: PromotionCodePreviewRequest["context"] | null, preview: PromotionCodePreviewResponse | null, idempotencyKey: string): PromotionCodeCreateRequest {
  if (!form.name.trim()) throw new Error("name_required");
  if (!form.validFrom) throw new Error("valid_from_required");
  const validFrom = fromDateTimeLocal(form.validFrom);
  const validTo = form.validTo ? fromDateTimeLocal(form.validTo) : null;
  if (validTo && Date.parse(validTo) <= Date.parse(validFrom)) throw new Error("validity_window_invalid");
  if (form.codeMode === "manual" && !/^[A-Za-z0-9_-]{3,64}$/.test(form.code.trim())) throw new Error("manual_code_invalid");
  return {
    name: form.name.trim(), description: form.description.trim() || null,
    code: form.codeMode === "automatic" ? { kind: "automatic" } : { kind: "manual", value: form.code.trim() },
    benefits: buildBenefits(form), scopes: buildScopes(form), validFrom, validTo,
    minimumReferenceMinor: parseMoneyMinor(form.minimumReference, { allowZero: true }),
    redemptionLimitGlobal: parseOptionalPositiveInteger(form.globalLimit),
    redemptionLimitPerCustomer: parseOptionalPositiveInteger(form.customerLimit), status: form.status,
    ...(form.status === "active" && context && preview ? { previewContext: context, previewProof: preview.previewProof } : {}),
    idempotencyKey,
  };
}

function buildBenefits(form: FormState): PromotionCodeCreateRequest["benefits"] {
  const benefits: PromotionCodeCreateRequest["benefits"] = [];
  if (form.productEnabled) benefits.push(form.productKind === "target_percentage" ? { lane: "product", kind: "target_percentage", valueBps: percentageBps(form.productValue) } : { lane: "product", kind: "fixed_amount", valueMinor: parseMoneyMinor(form.productValue) });
  if (form.shippingEnabled) benefits.push(form.shippingKind === "free_shipping" ? { lane: "shipping", kind: "free_shipping" } : form.shippingKind === "percentage" ? { lane: "shipping", kind: "percentage", valueBps: percentageBps(form.shippingValue) } : { lane: "shipping", kind: "fixed_amount", valueMinor: parseMoneyMinor(form.shippingValue) });
  if (benefits.length === 0) throw new Error("benefit_required");
  return benefits;
}

function buildScopes(form: FormState): PromotionCodeCreateRequest["scopes"] {
  const scopes: PromotionCodeCreateRequest["scopes"] = [];
  if (form.oneTime) scopes.push("one_time");
  if (form.subscription) scopes.push("subscription_initial");
  if (scopes.length === 0) throw new Error("scope_required");
  return scopes;
}

function percentageBps(value: string): number {
  const bps = Math.round(Number(value.replace(",", ".")) * 100);
  if (!Number.isInteger(bps) || bps < 1 || bps > 9_999) throw new Error("percentage_invalid");
  return bps;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm"><span className="text-text-muted">{label}</span>{children}</label>;
}
