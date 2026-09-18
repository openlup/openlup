import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ConsentCheckbox } from "@/components/forms/fields/ConsentCheckbox";
import {
  getCustomerCommunicationPreferences,
  updateCustomerCommunicationPreferences,
} from "@/domains/communications/customerPreferencesClient";
import type { CustomerCommunicationPreferencesResponse } from "@/domains/communications/customerPreferencesContracts";
import { BffClientError } from "@/lib/bff/client";
import {
  createCustomerDiagnosticActionKeyWhenEnabled,
  loadCustomerDiagnosticReporterWhenEnabled,
} from "@/lib/flags";
import { AccountCard, Eyebrow } from "../ui/atoms";

/**
 * Marketing-consent toggle. Self-fetches from the communications BFF (separate
 * from the account payload) and updates via updateCustomerCommunicationPreferences.
 */
export function CommunicationCard({ accessToken }: { accessToken: string }) {
  const { t } = useTranslation("account");
  const [prefs, setPrefs] = useState<CustomerCommunicationPreferencesResponse | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCustomerCommunicationPreferences(accessToken)
      .then((response) => {
        if (!cancelled) setPrefs(response);
      })
      .catch(() => {
        /* keep the toggle hidden if comms prefs are unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  if (!prefs) return null;
  const granted = prefs.marketingNewsletter.granted;

  async function toggle() {
    const diagnostic = startCommunicationDiagnostic(accessToken);
    setSaving(true);
    try {
      const next = await updateCustomerCommunicationPreferences(accessToken, {
        marketingNewsletterConsent: !granted,
      });
      setPrefs(next);
      diagnostic?.settle("succeeded");
      toast.success(t("account:dashboard.saved"));
    } catch (error) {
      diagnostic?.settle(communicationFailureCode(error), error);
      toast.error(t("account:dashboard.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AccountCard className="p-6">
      <Eyebrow>{t("account:dashboard.sectionsV2.comms.title")}</Eyebrow>
      <ConsentCheckbox
        checked={granted}
        disabled={saving}
        label={t("account:dashboard.sectionsV2.comms.marketing")}
        description={t("account:dashboard.sectionsV2.comms.marketingHint")}
        onCheckedChange={() => void toggle()}
        wrapperClassName="mt-3"
        labelClassName="text-sm font-semibold text-foreground"
        descriptionClassName="text-xs-plus text-foreground/55"
      />
    </AccountCard>
  );
}

type CommunicationDiagnosticCode = "succeeded" | "rejected" | "failed" | "unknown" | "timeout" | "transport_uncertain";

function startCommunicationDiagnostic(accessToken: string): { settle: (code: CommunicationDiagnosticCode, error?: unknown) => void } | null {
  try {
    const clientActionKey = createCustomerDiagnosticActionKeyWhenEnabled?.();
    const reporter = loadCustomerDiagnosticReporterWhenEnabled?.();
    if (!clientActionKey || !reporter) return null;
    const report = (phase: "attempted" | "settled", code: "observed" | CommunicationDiagnosticCode, error?: unknown) => {
      const relatedRequestId = error instanceof BffClientError ? error.requestId : undefined;
      void reporter.then((loadedReporter) => {
        try {
          loadedReporter?.reportCustomerJourneyDiagnostic({
            action: "account_communication_mutation",
            phase,
            code,
            clientActionKey,
            ...(relatedRequestId ? { relatedRequestId } : {}),
          }, accessToken);
        } catch {
          // Diagnostics are never allowed to change consent behavior.
        }
      }).catch(() => undefined);
    };
    report("attempted", "observed");
    return { settle: (code, error) => report("settled", code, error) };
  } catch {
    return null;
  }
}

function communicationFailureCode(error: unknown): Exclude<CommunicationDiagnosticCode, "succeeded"> {
  if (error instanceof BffClientError) {
    if (error.status === 0 && error.details && typeof error.details === "object" && "reason" in error.details && error.details.reason === "timeout") {
      return "timeout";
    }
    if (error.status === 0) return "transport_uncertain";
    if (error.status >= 400 && error.status < 500) return "rejected";
    return "unknown";
  }
  return error instanceof TypeError ? "transport_uncertain" : "unknown";
}
