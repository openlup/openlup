import type { TFunction } from "i18next";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { InfoBlock } from "./OrderDetailBlocks";
import { compactParts } from "@/lib/utils";

export function SelectedDeliveryBlock({
  detail,
  t,
}: {
  detail: OmsOrderDetail;
  t: TFunction;
}) {
  return (
    <InfoBlock
      label={t("admin:adminOms.detail.selectedDelivery")}
      value={selectedDeliveryValue(detail) || t("admin:adminOms.detail.notAvailable")}
      meta={selectedDeliveryMeta(detail)}
    />
  );
}

function selectedDeliveryValue(detail: OmsOrderDetail): string {
  const selection = detail.deliverySelection;
  if (!selection) return "";
  return compactParts([
    selection.carrierKind?.toUpperCase(),
    selection.deliveryKind,
    selection.serviceCode,
  ]).join(" / ");
}

function selectedDeliveryMeta(detail: OmsOrderDetail): string {
  const selection = detail.deliverySelection;
  if (!selection) return "";
  return compactParts([
    selection.pickupPoint ? `${selection.pickupPoint.name} (${selection.pickupPoint.id})` : null,
    selection.source ? `source ${selection.source}` : null,
  ]).join(" · ");
}
