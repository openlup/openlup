import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { getReferenceInvoiceOrderSummary } from "@/domains/accounting/referenceInvoicingClient";
import { OrderDetailAccountingSection } from "./OrderDetailAccountingSection";

export function OrderDetailAccountingPanel({
  accessToken,
  orderId,
  locale,
  t,
}: {
  accessToken: string | undefined;
  orderId: string;
  locale: string;
  t: TFunction;
}) {
  const accountingQuery = useQuery({
    queryKey: ["admin-accounting-order-summary", orderId, accessToken],
    enabled: Boolean(orderId && accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error("Admin session required");
      return getReferenceInvoiceOrderSummary(accessToken, orderId);
    },
    retry: false,
  });

  return (
    <OrderDetailAccountingSection
      summary={accountingQuery.data?.summary ?? null}
      isLoading={accountingQuery.isLoading}
      isError={accountingQuery.isError}
      isFetching={accountingQuery.isFetching}
      locale={locale}
      t={t}
      onRetry={() => {
        void accountingQuery.refetch();
      }}
    />
  );
}
