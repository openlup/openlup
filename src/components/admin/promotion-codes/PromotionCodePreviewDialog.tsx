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
import {
  previewAdminPromotionCode,
  updateAdminPromotionCode,
} from "@/domains/commerce/adminPromotionCodesClient";
import type {
  PromotionCodePreviewRequest,
  PromotionCodePreviewResponse,
  PromotionCodeSummary,
} from "@/domains/commerce/adminPromotionCodesContracts";

import { PromotionCodePreviewResults } from "./PromotionCodePreviewResults";
import { createIdempotencyKey, type PreviewContextIssue } from "./promotionCodeUi";

export type PreviewablePromotionCode = PromotionCodeSummary;

interface Props {
  accessToken: string;
  code: PreviewablePromotionCode | null;
  context: PromotionCodePreviewRequest["context"] | null;
  /** Which half of the context is missing; `null` keeps the generic sentence. */
  contextIssue?: PreviewContextIssue;
  activationRequested?: boolean;
  onClose: () => void;
}

export function PromotionCodePreviewDialog({
  accessToken,
  code,
  context,
  contextIssue = null,
  activationRequested = false,
  onClose,
}: Props) {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<PromotionCodePreviewResponse | null>(null);
  const activationKey = useRef(createIdempotencyKey());

  useEffect(() => {
    setPreview(null);
    activationKey.current = createIdempotencyKey();
  }, [code?.id, context]);

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!code || !context) throw new Error("preview_context_unavailable");
      return previewAdminPromotionCode(accessToken, previewRequest(code, context));
    },
    onSuccess: setPreview,
    onError: () => toast.error(t("admin:adminPromotionCodes.toast.previewError")),
  });

  const activationMutation = useMutation({
    mutationFn: async () => {
      if (!code || !context || !preview) throw new Error("promotion_preview_required");
      return updateAdminPromotionCode(accessToken, {
        id: code.id,
        expectedRevision: code.revision,
        updates: { status: "active" },
        previewContext: context,
        previewProof: preview.previewProof,
        idempotencyKey: activationKey.current,
      });
    },
    onSuccess: async () => {
      toast.success(t("admin:adminPromotionCodes.toast.activated"));
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
      toast.error(t("admin:adminPromotionCodes.toast.activationError"));
    },
  });

  return (
    <Dialog open={Boolean(code)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-warm-sand bg-white text-teal-dark sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-semibold">
            {activationRequested ? t("admin:adminPromotionCodes.previewDialog.activationTitle") : t("admin:adminPromotionCodes.previewDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("admin:adminPromotionCodes.previewDialog.description", { code: code?.code })}
          </DialogDescription>
        </DialogHeader>

        {!context && (
          <p role="alert" className="rounded-control bg-destructive/10 p-3 text-sm text-destructive">
            {contextIssue === "band_empty" ? t("admin:adminPromotionCodes.previewDialog.bandEmpty")
              : contextIssue === "band_error" ? t("admin:adminPromotionCodes.previewDialog.bandError")
              : contextIssue === "shipping_error" ? t("admin:adminPromotionCodes.previewDialog.shippingError")
              : t("admin:adminPromotionCodes.previewDialog.missingContext")}
          </p>
        )}
        {preview && <PromotionCodePreviewResults preview={preview} />}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t("admin:adminPromotionCodes.previewDialog.close")}</Button>
          <Button
            type="button"
            variant="outline"
            disabled={!context || previewMutation.isPending || activationMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending ? t("admin:adminPromotionCodes.previewDialog.calculating") : preview ? t("admin:adminPromotionCodes.previewDialog.refresh") : t("admin:adminPromotionCodes.previewDialog.run")}
          </Button>
          {activationRequested && (
            <Button
              type="button"
              disabled={!preview || activationMutation.isPending}
              onClick={() => activationMutation.mutate()}
            >
              {activationMutation.isPending ? t("admin:adminPromotionCodes.previewDialog.activating") : t("admin:adminPromotionCodes.previewDialog.activate")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function previewRequest(
  code: PreviewablePromotionCode,
  context: PromotionCodePreviewRequest["context"],
): PromotionCodePreviewRequest {
  return {
    benefits: code.benefits,
    scopes: code.scopes,
    promotionEngineVersion: code.promotionEngineVersion,
    minimumReferenceMinor: code.minimumReferenceMinor,
    context,
  };
}
