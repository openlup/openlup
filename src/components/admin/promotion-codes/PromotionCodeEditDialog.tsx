import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  previewAdminPromotionCode,
  updateAdminPromotionCode,
} from "@/domains/commerce/adminPromotionCodesClient";
import type { PromotionCodePreviewRequest } from "@/domains/commerce/adminPromotionCodesContracts";

import type { PreviewablePromotionCode } from "./PromotionCodePreviewDialog";
import {
  createIdempotencyKey,
  fromDateTimeLocal,
  parseOptionalPositiveInteger,
  toDateTimeLocal,
} from "./promotionCodeUi";

interface Props {
  accessToken: string;
  code: PreviewablePromotionCode | null;
  context: PromotionCodePreviewRequest["context"] | null;
  onClose: () => void;
}

export function PromotionCodeEditDialog({ accessToken, code, context, onClose }: Props) {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [globalLimit, setGlobalLimit] = useState("");
  const [customerLimit, setCustomerLimit] = useState("");
  const idempotencyKey = useRef(createIdempotencyKey());

  useEffect(() => {
    if (!code) return;
    setValidFrom(toDateTimeLocal(code.validFrom));
    setValidTo(code.validTo ? toDateTimeLocal(code.validTo) : "");
    setGlobalLimit(code.redemptionLimitGlobal?.toString() ?? "");
    setCustomerLimit(code.redemptionLimitPerCustomer?.toString() ?? "");
    idempotencyKey.current = createIdempotencyKey();
  }, [code]);
  useEffect(() => {
    idempotencyKey.current = createIdempotencyKey();
  }, [validFrom, validTo, globalLimit, customerLimit]);

  const save = useMutation({
    mutationFn: async () => {
      if (!code || !context) throw new Error("preview_context_unavailable");
      const nextValidFrom = fromDateTimeLocal(validFrom);
      const nextValidTo = validTo ? fromDateTimeLocal(validTo) : null;
      if (nextValidTo && Date.parse(nextValidTo) <= Date.parse(nextValidFrom)) {
        throw new Error("validity_window_invalid");
      }
      const previewInput: PromotionCodePreviewRequest = {
        benefits: code.benefits,
        scopes: code.scopes,
        promotionEngineVersion: code.promotionEngineVersion,
        minimumReferenceMinor: code.minimumReferenceMinor,
        context,
      };
      const preview = await previewAdminPromotionCode(accessToken, previewInput);
      return updateAdminPromotionCode(accessToken, {
        id: code.id,
        expectedRevision: code.revision,
        updates: {
          validFrom: nextValidFrom,
          validTo: nextValidTo,
          redemptionLimitGlobal: parseOptionalPositiveInteger(globalLimit),
          redemptionLimitPerCustomer: parseOptionalPositiveInteger(customerLimit),
        },
        previewContext: context,
        previewProof: preview.previewProof,
        idempotencyKey: idempotencyKey.current,
      });
    },
    onSuccess: async () => {
      toast.success(t("admin:adminPromotionCodes.toast.saved"));
      await queryClient.invalidateQueries({ queryKey: ["admin-promotion-codes"] });
      onClose();
    },
    onError: async (error) => {
      const status = typeof error === "object" && error && "status" in error ? error.status : null;
      if (status === 409) {
        toast.error(t("admin:adminPromotionCodes.toast.conflict"));
        await queryClient.invalidateQueries({ queryKey: ["admin-promotion-codes"] });
        onClose();
        return;
      }
      if (error instanceof Error && error.message === "validity_window_invalid") {
        toast.error(t("admin:adminPromotionCodes.toast.validityError"));
      } else {
        toast.error(t("admin:adminPromotionCodes.toast.saveError"));
      }
    },
  });

  return (
    <Dialog open={Boolean(code)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="border-warm-sand bg-white text-teal-dark sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-semibold">{t("admin:adminPromotionCodes.editDialog.title", { code: code?.code })}</DialogTitle>
          <DialogDescription>
            {t("admin:adminPromotionCodes.editDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("admin:adminPromotionCodes.createDialog.validFrom")}>
            <Input type="datetime-local" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} />
          </Field>
          <Field label={t("admin:adminPromotionCodes.createDialog.validTo")}>
            <Input type="datetime-local" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
          </Field>
          <Field label={t("admin:adminPromotionCodes.createDialog.globalLimit")}>
            <Input type="number" min={1} value={globalLimit} onChange={(event) => setGlobalLimit(event.target.value)} />
          </Field>
          <Field label={t("admin:adminPromotionCodes.createDialog.customerLimit")}>
            <Input type="number" min={1} value={customerLimit} onChange={(event) => setCustomerLimit(event.target.value)} />
          </Field>
        </div>
        {!context && (
          <p role="alert" className="text-sm text-destructive">
            {t("admin:adminPromotionCodes.editDialog.missingContext")}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t("admin:adminPromotionCodes.createDialog.cancel")}</Button>
          <Button type="button" disabled={!context || !validFrom || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t("admin:adminPromotionCodes.editDialog.checking") : t("admin:adminPromotionCodes.editDialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-text-muted">{label}</span>
      {children}
    </label>
  );
}
