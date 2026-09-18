import { useTranslation } from "react-i18next";
import { RotateCcw, TriangleAlert } from "lucide-react";

import { AccountCard, CoralButton, SectionTitle } from "./atoms";

/**
 * Cream loading + error states for the V2 account (rendered inside the
 * `.account-light` scope set by DashboardPage). Replace the bare <p> fallbacks.
 */

function Bar({ className = "" }: { className?: string }) {
  return <span className={`block animate-pulse rounded-full bg-teal-dark/8 ${className}`} />;
}

/** Skeleton mimicking the shell (topbar + sidebar + content cards). */
export function AccountSkeleton() {
  const { t } = useTranslation("account");
  return (
    <>
      <span role="status" className="sr-only">
        {t("account:dashboard.loading")}
      </span>
      <div aria-hidden className="min-h-screen bg-background">
      <div className="h-16 border-b border-teal-dark/8 bg-offwhite/85" />
      <div className="mx-auto grid max-w-[1320px] grid-cols-1 gap-7 px-4 py-7 sm:px-7 lg:grid-cols-[232px_minmax(0,1fr)]">
        <div className="hidden space-y-2 lg:block">
          {Array.from({ length: 7 }).map((_, index) => (
            <Bar key={index} className="h-10 w-full" />
          ))}
        </div>
        <div className="space-y-5">
          <Bar className="h-9 w-64" />
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <AccountCard key={index} className="h-28 p-5">
                <Bar className="h-3 w-20" />
                <Bar className="mt-3 h-6 w-28" />
              </AccountCard>
            ))}
          </div>
          <AccountCard className="h-64 p-7">
            <Bar className="h-3 w-24" />
            <Bar className="mt-3 h-7 w-56" />
            <div className="mt-6 flex gap-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <Bar key={index} className="h-20 w-20" />
              ))}
            </div>
            <Bar className="mt-6 h-2.5 w-full" />
          </AccountCard>
        </div>
      </div>
      </div>
    </>
  );
}

/** Error card shown when the account payload can't be loaded. */
export function AccountErrorCard({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation("account");
  return (
    <div className="mx-auto max-w-[1320px] px-4 py-10 sm:px-7">
      <AccountCard className="flex flex-col items-start gap-3 p-8">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-warm-coral/12 text-warm-coral">
          <TriangleAlert size={24} />
        </span>
        <SectionTitle className="text-xl">{t("account:dashboard.errorTitle")}</SectionTitle>
        <p className="text-sm text-foreground/60">{t("account:dashboard.unavailable")}</p>
        <CoralButton icon={<RotateCcw size={16} />} onClick={onRetry}>
          {t("account:dashboard.retry")}
        </CoralButton>
      </AccountCard>
    </div>
  );
}
