export interface EmailLifecycleDecision {
  event: string;
  decision: "send" | "no_send" | "provider_only" | "covered_by_existing";
  owner: string;
  endUserRationale: string;
  opsRationale: string;
  targetSlug?: string;
}

export const EMAIL_CANON_LIFECYCLE_DECISIONS = [
  {
    event: "account-deletion-rodo",
    decision: "send",
    owner: "customer-account",
    targetSlug: "account-deletion-confirmation",
    endUserRationale: "Klient potrzebuje potwierdzenia, że konto i dane zostały objęte procesem usunięcia.",
    opsRationale: "Support musi mieć ledger potwierdzający wysyłkę albo skip/fail reason.",
  },
  {
    event: "invoice-issued-receipt",
    decision: "send",
    owner: "commerce-communications",
    targetSlug: "commerce-invoice-document",
    endUserRationale: "Klient dostaje jeden mail sklepu z PDF wystawionym i przechowywanym przez wybranego dostawcę dokumentów.",
    opsRationale: "Resend daje wspólny ledger przyjęcia i mierzalnego statusu wiadomości bez przenoszenia kompetencji fiskalnych do systemu ecommerce.",
  },
  {
    event: "renewal-charged",
    decision: "covered_by_existing",
    owner: "subscriptions",
    targetSlug: "commerce-order-paid",
    endUserRationale: "Potwierdzenie opłacenia cyklu subskrypcji nie powinno dublować receipt maila.",
    opsRationale: "Support sprawdza mail commerce-order-paid dla danego cyklu.",
  },
  {
    event: "card-expiring",
    decision: "send",
    owner: "subscriptions",
    targetSlug: "subscription-card-expiring",
    endUserRationale: "Klient powinien dostać recovery CTA tylko gdy mamy pewne źródło daty wygaśnięcia karty.",
    opsRationale: "Wysyłka wymaga wiarygodnego provider signal i recovery URL w ledgerze.",
  },
  {
    event: "admin-dunning-escalation",
    decision: "send",
    owner: "operations",
    targetSlug: "subscription-dunning-admin-escalation",
    endUserRationale: "Klient nie dostaje dodatkowego maila przy każdej próbie; zespół reaguje po progu ryzyka.",
    opsRationale: "Alert po thresholdzie ogranicza szum i pokazuje backlog wymagający interwencji.",
  },
] as const satisfies readonly EmailLifecycleDecision[];
