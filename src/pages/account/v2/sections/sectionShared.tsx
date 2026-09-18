import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AccountCard, SectionTitle } from "../ui/atoms";

/** Page header (title + subtitle) shared by the secondary account sections. */
export function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <SectionTitle as="h1" className="text-3xl">
        {title}
      </SectionTitle>
      <p className="mt-1 text-foreground/60">{subtitle}</p>
    </div>
  );
}

/** Empty-state card used by the secondary account sections. */
export function EmptyCard({ children }: { children: ReactNode }) {
  return (
    <AccountCard className="p-7">
      <p className="text-sm text-foreground/55">{children}</p>
    </AccountCard>
  );
}

/**
 * Inline failure notice for the account form dialogs. `AccountMutate` reports a
 * failed save as `false` rather than a rejection, so a dialog that stays open on
 * that flag also has to say why it stayed open: the toast raised by
 * `runMutation` is transient and does not explain the dialog still standing
 * there. Same shape as the subscription package editor's inline error.
 */
export function SaveErrorAlert() {
  const { t } = useTranslation("account");
  return (
    <p role="alert" className="rounded-control bg-warm-coral/10 px-3 py-2 text-sm text-warm-coral">
      {t("account:dashboard.saveFailed")}
    </p>
  );
}
