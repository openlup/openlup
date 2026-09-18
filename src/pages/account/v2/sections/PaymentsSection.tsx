import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CreditCard, Loader2, Pencil, ShieldCheck } from "lucide-react";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import { upsertCustomerPaymentPreference } from "@/domains/customers/customerPreferencesClient";
import { hasOpenRecoveryCase } from "../lib/dunningFacts";
import { dateLabel } from "../../DashboardPanelUtils";
import type { AccountMutate, AccountRefresh } from "../../AccountWorkspaceTypes";
import type { AccountLang } from "../lib/format";
import {
  resolveRecoveryCaptureFlows,
  type PaymentMethodCaptureFlow,
} from "@/domains/payment/contracts";
import { AccountCard, CoralButton, GhostButton } from "../ui/atoms";
import { EmptyCard, SectionHeader } from "./sectionShared";
import { SelectField } from "./formFields";
import { PaymentCardSetup } from "./PaymentCardSetup";

type Scope = "one_time" | "subscription" | "any";
type MethodKind = "blik" | "card" | "transfer";
const SCOPES: Scope[] = ["subscription", "one_time", "any"];
const METHODS: MethodKind[] = ["blik", "card", "transfer"];

/**
 * Which methods may be PREFERRED for a subscription.
 *
 * A subscription is charged with nobody present, so the only honest options are
 * the ones this deployment can actually capture and drive unattended. That set is
 * read from the adapters' declared capture flows — the same resolution the repair
 * page uses — and never hardcoded to `"card"`: a deployment that gains a
 * mandate-capable rail should gain the option by declaring it, not by someone
 * remembering to edit this list.
 *
 * The old list offered BLIK and transfer here. For a payer whose bank cannot back
 * a recurring mandate that was not a choice, it was the exact wrong turn dressed
 * as a fix, sitting directly above the control that would have helped.
 */
const CAPTURE_FLOW_METHODS: Readonly<Record<string, MethodKind>> = { card_on_file_setup: "card" };

function subscriptionMethods(
  flows?: readonly PaymentMethodCaptureFlow[],
): MethodKind[] {
  const offered = resolveRecoveryCaptureFlows(flows).offered;
  return METHODS.filter((method) =>
    offered.some((flow) => CAPTURE_FLOW_METHODS[flow] === method),
  );
}

function methodLabel(kind: string | null, t: (k: string) => string): string {
  const key = kind?.toLowerCase();
  if (key === "blik" || key === "card" || key === "transfer") {
    return t(`account:dashboard.subscriptionV2.paymentMethod.${key}`);
  }
  return kind ?? t("account:dashboard.subscriptionV2.paymentMethod.fallback");
}

export function PaymentsSection({
  account,
  lang,
  accessToken,
  mutate,
  refresh,
  targetSubscriptionId,
  captureFlows,
}: {
  account: CustomerAccountV2Response;
  lang: AccountLang;
  accessToken: string;
  mutate: AccountMutate;
  refresh?: AccountRefresh;
  targetSubscriptionId: string | null;
  /** Declared capture flows; defaults to this deployment's. Injected by tests. */
  captureFlows?: readonly PaymentMethodCaptureFlow[];
}) {
  const { t } = useTranslation("account");
  const preference =
    account.paymentPreferences.find((item) => item.scope === "subscription") ??
    account.paymentPreferences[0] ??
    null;
  // Card capture is subscription-scoped. The URL-selected subscription is the
  // authority; never guess from array order when a customer owns several plans.
  const cardSubscriptionId = targetSubscriptionId;

  // An open recovery case is what makes this panel urgent rather than routine: it
  // reorders the panel, changes what the save confirmation promises, and is the
  // one signal that the stored method has already failed rather than merely being
  // an odd choice.
  const inOpenRecovery = hasOpenRecoveryCase(account.actionRequired, cardSubscriptionId);
  const subscriptionOnly = subscriptionMethods(captureFlows);
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState<Scope>((preference?.scope as Scope) ?? "subscription");
  const [methodKind, setMethodKind] = useState<MethodKind>((preference?.methodKind as MethodKind) ?? "blik");
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setScope((preference?.scope as Scope) ?? "subscription");
    setMethodKind((preference?.methodKind as MethodKind) ?? "blik");
    setEditing(true);
  }
  async function save() {
    setSaving(true);
    try {
      await mutate(() => upsertCustomerPaymentPreference(accessToken, { scope, methodKind }), "account_payment_mutation");
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  // Rendered in one of two slots, never both. When the stored method has already
  // failed, capture leads and the preference follows; otherwise the panel keeps
  // its familiar order. Same element either way, so the two slots cannot drift
  // into two different forms.
  const cardCapture = cardSubscriptionId ? (
    <AccountCard className="space-y-3 p-6">
      <div>
        <p className="font-display text-base font-bold text-foreground">
          {t("account:dashboard.sectionsV2.payments.card.title")}
        </p>
        <p className="text-sm text-foreground/55">
          {t(`account:dashboard.sectionsV2.payments.card.${inOpenRecovery ? "subtitleInRecovery" : "subtitle"}`)}
        </p>
      </div>
      <PaymentCardSetup
        subscriptionId={cardSubscriptionId}
        accessToken={accessToken}
        inOpenRecovery={inOpenRecovery}
        onSaved={refresh ? () => { void refresh(); } : undefined}
      />
    </AccountCard>
  ) : null;

  return (
    <div className="space-y-5">
      <SectionHeader
        title={t("account:dashboard.sectionsV2.payments.title")}
        subtitle={t("account:dashboard.sectionsV2.payments.subtitle")}
      />

      {inOpenRecovery ? cardCapture : null}
      {editing ? (
        <AccountCard className="space-y-3 p-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label={t("account:dashboard.sectionsV2.payments.method")}
              value={methodKind}
              onChange={(value) => setMethodKind(value as MethodKind)}
              options={(scope === "subscription" ? subscriptionOnly : METHODS).map((value) => ({
                value,
                label: methodLabel(value, t),
              }))}
            />
            <SelectField
              label={t("account:dashboard.sectionsV2.payments.scopeLabel")}
              value={scope}
              onChange={(value) => {
                const next = value as Scope;
                setScope(next);
                // Narrowing the list must never leave a stale, unofferable value
                // selected: the payer would save a preference the panel no longer
                // shows, which is worse than the wrong turn this wave removes.
                if (next === "subscription" && !subscriptionOnly.includes(methodKind)) {
                  setMethodKind(subscriptionOnly[0] ?? methodKind);
                }
              }}
              options={SCOPES.map((value) => ({
                value,
                label: t(`account:dashboard.sectionsV2.payments.scope.${value}`),
              }))}
            />
          </div>
          <div className="flex items-center justify-end gap-3">
            <GhostButton onClick={() => setEditing(false)} disabled={saving}>
              {t("account:dashboard.workspace.cancel")}
            </GhostButton>
            <CoralButton
              onClick={save}
              disabled={saving}
              icon={saving ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : undefined}
            >
              {t("account:dashboard.workspace.save")}
            </CoralButton>
          </div>
        </AccountCard>
      ) : preference ? (
        <AccountCard className="flex items-center gap-4 p-6">
          <span className="grid h-12 w-12 place-items-center rounded-control bg-teal/10 text-teal">
            <CreditCard size={20} />
          </span>
          <div className="flex-1">
            <p className="font-display text-lg font-bold text-foreground">
              {methodLabel(preference.methodKind, t)}
            </p>
            <p className="text-sm text-foreground/55">
              {t(`account:dashboard.sectionsV2.payments.scope.${preference.scope}`, { defaultValue: preference.scope })}
              {" · "}
              {dateLabel(preference.lastSelectedAt, lang, "–")}
            </p>
          </div>
          <button
            type="button"
            onClick={startEdit}
            className="focus-ring inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-sm font-semibold text-teal hover:underline"
          >
            <Pencil size={14} />
            {t("account:dashboard.workspace.edit")}
          </button>
        </AccountCard>
      ) : (
        <div className="space-y-3">
          <EmptyCard>{t("account:dashboard.sectionsV2.payments.empty")}</EmptyCard>
          <CoralButton icon={<Pencil size={16} />} onClick={startEdit}>
            {t("account:dashboard.sectionsV2.payments.choosePreference")}
          </CoralButton>
        </div>
      )}

      {inOpenRecovery ? null : cardCapture}

      <p className="flex items-center gap-2 text-sm text-foreground/55">
        <ShieldCheck size={16} className="shrink-0 text-teal" />
        {t("account:dashboard.sectionsV2.payments.securityNote")}
      </p>
    </div>
  );
}
