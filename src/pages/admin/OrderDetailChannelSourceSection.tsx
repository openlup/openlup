import type { TFunction } from "i18next";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { DetailSection, InfoBlock } from "./OrderDetailBlocks";

// Where this order was sold, for the operator who has to answer a question about
// it. A storefront order renders NOTHING: the section exists to say "this order
// came from somewhere else", and rendering "storefront" on every order would
// make the one case that matters harder to spot rather than easier.
//
// Every value here is already on the detail response — `sourceKind` and
// `sourceChannelSlug` since the source axis wave, `sourceOrderRef` since this
// one — so the section costs no extra read.
export function ChannelSourceSection({
  detail,
  t,
}: {
  detail: OmsOrderDetail;
  t: TFunction;
}) {
  const channelSlug = detail.sourceChannelSlug;
  if (!channelSlug) return null;

  return (
    <DetailSection
      testId="admin-oms-channel-source"
      variant="plain"
      title={t("admin:adminOms.detail.channelSourceTitle")}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <InfoBlock
          label={t("admin:adminOms.detail.channelSlug")}
          value={channelSlug}
          // Selling surfaces are an open registry, not a closed vocabulary, so
          // an unknown kind falls back to the stored token rather than to a
          // missing-translation marker.
          meta={detail.sourceKind
            ? t(`admin:adminOms.sourceKind.${detail.sourceKind}`, { defaultValue: detail.sourceKind })
            : ""}
        />
        <InfoBlock
          label={t("admin:adminOms.detail.channelExternalOrderRef")}
          // The far side's own identifier, verbatim — an operator has to be able
          // to paste it into the marketplace's back office.
          value={detail.sourceOrderRef ?? t("admin:adminOms.detail.channelExternalOrderRefMissing")}
          meta=""
        />
      </div>
    </DetailSection>
  );
}
