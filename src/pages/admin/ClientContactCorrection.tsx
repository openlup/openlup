import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Mail, Merge, Phone } from "lucide-react";
import { Input } from "@/components/ui/input";
import { normalizePhoneToE164 } from "@/lib/schemas/fields/phone";
import type { Customer360SnapshotResponse } from "@/domains/support/customer360Contracts";
import { ActionButton } from "./OrderDetailBlocks";
import { formatDate } from "./ordersPageUtils";

type Subject = Customer360SnapshotResponse["subject"];
type Translate = ReturnType<typeof useTranslation>["t"];
type ConfirmKind = "correctEmail" | "correctPhone" | "absorbLead";

/**
 * The address a correction could not take, and the record sitting on it.
 *
 * `absorbed` is a distinct state from "no holder": after the lead is folded in,
 * the address is free but the correction has *not* been sent again, and telling
 * an operator that the second half is still theirs to press is the whole point of
 * splitting this into two confirmed steps.
 */
export type HeldAddress = {
  holderId: string;
  email: string;
  absorbed: boolean;
  refusal: { code: string; tables: string[] } | null;
};

export interface ContactCorrectionProps {
  subject: Subject;
  busy: boolean;
  locale: string;
  /** The card owns the mutation, the idempotency key and the toast. */
  onCorrectEmail: (input: { expectedEmail: string; newEmail: string }) => void;
  onCorrectPhone: (input: { expectedPhone: string; newPhone: string }) => void;
  onAbsorbLead: (input: { leadId: string; expectedLeadEmail: string }) => void;
  /** The last correction that was refused because somebody else held the address. */
  held: HeldAddress | null;
  /** That holder's own snapshot, once it has been read. */
  holder: Customer360SnapshotResponse | null;
  holderPending: boolean;
  confirmCopy: (kind: ConfirmKind) => {
    title: string; description: string; actionLabel: string; cancelLabel: string;
  };
}

/**
 * The two contact values an operator may repair, and the reason each matters.
 *
 * The address is the sign-in identity as well as the mailbox, so correcting it
 * moves the authorization copy too - the route does that before the record is
 * written. That is why the sign-in state below is *context* rather than a gate: it
 * used to withhold the correction from every account checkout had linked, which is
 * every buyer, including the one who mistyped her address and could therefore
 * never reach the account at all.
 *
 * The number is not an identity. It matters because the fulfillment dispatch
 * payload carries `clients.phone` verbatim, so the courier's SMS goes wherever
 * this value points - and an address-book phone edited elsewhere in the panel does
 * not reach it.
 */
export function ClientContactCorrection({
  subject, busy, locale, onCorrectEmail, onCorrectPhone, onAbsorbLead, held, holder, holderPending, confirmCopy,
}: ContactCorrectionProps) {
  const { t } = useTranslation("admin");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const leaf = (name: string) => t(`admin:adminClients.detail.actions.${name}`);

  const emailReady = newEmail.trim() !== "";
  const normalizedPhone = normalizePhoneToE164(newPhone);
  const phoneReady = normalizedPhone !== null;
  const signIn = signInContext(subject);

  return (
    <section className="space-y-3" data-testid="admin-client-contact-correction">
      <h3 className="label-text text-teal">{leaf("contactHeading")}</h3>
      <p className="text-xs text-text-muted">{leaf("contactHint")}</p>

      {/* Context, not a gate. An operator deciding whether to move an address wants
          to know whether anyone is actually using it to sign in. */}
      {signIn === null ? null : (
        <p className="text-xs text-text-muted" data-testid="admin-client-sign-in-context">
          {t(`admin:adminClients.detail.actions.${signIn}`)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2" data-testid="admin-client-email-correction">
        <label className="label-text text-text-muted" htmlFor="admin-client-new-email">{leaf("newEmailLabel")}</label>
        <Input
          id="admin-client-new-email" data-testid="admin-client-email-correction-input" type="email"
          className="h-8 w-64 text-xs" value={newEmail} onChange={(event) => setNewEmail(event.target.value)}
        />
        <ActionButton
          icon={Mail} label={leaf("correctEmail")} disabled={busy || !emailReady}
          disabledReason={emailReady ? null : leaf("needEmail")}
          confirm={confirmCopy("correctEmail")} testId="admin-client-email-correction-submit"
          onClick={() => onCorrectEmail({
            expectedEmail: subject.email ?? "",
            newEmail: newEmail.trim().toLowerCase(),
          })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2" data-testid="admin-client-phone-correction">
        <label className="label-text text-text-muted" htmlFor="admin-client-new-phone">{leaf("newPhoneLabel")}</label>
        <Input
          id="admin-client-new-phone" data-testid="admin-client-phone-correction-input" type="tel"
          className="h-8 w-64 text-xs" value={newPhone} onChange={(event) => setNewPhone(event.target.value)}
        />
        <ActionButton
          icon={Phone} label={leaf("correctPhone")} disabled={busy || !phoneReady}
          // A national number is accepted in the field and normalized on submit, so
          // the reason names what is wrong rather than demanding a format silently.
          disabledReason={phoneReady ? null : leaf("needPhone")}
          confirm={confirmCopy("correctPhone")} testId="admin-client-phone-correction-submit"
          onClick={() => {
            if (normalizedPhone === null) return;
            onCorrectPhone({ expectedPhone: subject.phone ?? "", newPhone: normalizedPhone });
          }}
        />
        {phoneReady && normalizedPhone !== newPhone.trim() ? (
          <span className="text-xs text-text-muted" data-testid="admin-client-phone-normalized">
            {leaf("phoneNormalizedAs")} {normalizedPhone}
          </span>
        ) : null}
      </div>

      <HeldAddressNotice
        held={held} holder={holder} holderPending={holderPending} busy={busy}
        locale={locale} confirmCopy={confirmCopy} onAbsorbLead={onAbsorbLead}
      />
    </section>
  );
}

/**
 * What the record holding the address is, and whether it can be folded in.
 *
 * The preview is computed from the holder's own snapshot rather than asked of the
 * authority, because a button that reliably refuses is worse than no button: an
 * operator presses it, is told "no", and has learned nothing they could act on.
 * The authority still decides - it re-checks every blocker inside the same
 * transaction as the move, against the live foreign-key set - so this preview is
 * allowed to be conservative and never allowed to be optimistic. That is why an
 * unreadable holder and an unknown sign-in state both block: fail closed.
 */
function HeldAddressNotice({ held, holder, holderPending, busy, locale, confirmCopy, onAbsorbLead }: {
  held: HeldAddress | null;
  holder: Customer360SnapshotResponse | null;
  holderPending: boolean;
  busy: boolean;
  locale: string;
  confirmCopy: ContactCorrectionProps["confirmCopy"];
  onAbsorbLead: ContactCorrectionProps["onAbsorbLead"];
}) {
  const { t } = useTranslation("admin");
  const leaf = (name: string) => t(`admin:adminClients.detail.actions.absorb.${name}`);
  if (!held) return null;

  const blockers = holder ? absorptionBlockers(holder) : ["unreadable"];
  return (
    <div className="space-y-2 rounded-control border border-warm-sand p-3" data-testid="admin-client-held-address">
      <p className="label-text text-teal">{leaf("heading")}</p>
      <p className="text-sm text-teal-dark">{t("admin:adminClients.detail.actions.absorb.intro", { email: held.email })}</p>

      {held.absorbed ? (
        <p className="text-sm text-teal-dark" data-testid="admin-client-held-address-absorbed">{leaf("absorbed")}</p>
      ) : holderPending ? (
        <p className="text-sm text-text-muted" data-testid="admin-client-held-address-pending">{leaf("pending")}</p>
      ) : (
        <>
          {holder ? (
            <p className="text-sm text-text-muted" data-testid="admin-client-held-address-holder">
              {t("admin:adminClients.detail.actions.absorb.holderIs", {
                stage: t(`admin:adminClients.stages.${holder.subject.lifecycleStage}`),
                since: holder.subject.firstSeenAt ? formatDate(holder.subject.firstSeenAt, locale) : leaf("unknownDate"),
                orders: holder.orders.length,
                subscriptions: holder.subscriptions.length,
              })}
            </p>
          ) : null}

          {blockers.length === 0 ? (
            <ActionButton
              icon={Merge} label={leaf("absorb")} disabled={busy} disabledReason={null}
              confirm={confirmCopy("absorbLead")} testId="admin-client-absorb-lead-submit"
              onClick={() => onAbsorbLead({ leadId: held.holderId, expectedLeadEmail: held.email })}
            />
          ) : (
            <div className="space-y-1" data-testid="admin-client-absorb-blocked">
              <p className="text-sm text-teal-dark">{leaf("blockedHeading")}</p>
              <ul className="list-disc pl-5 text-sm text-text-muted">
                {blockers.map((code) => <li key={code}>{t(`admin:adminClients.detail.actions.absorb.blocked.${code}`)}</li>)}
              </ul>
            </div>
          )}
        </>
      )}

      {held.refusal ? (
        <div className="space-y-1" data-testid="admin-client-absorb-refusal">
          <p className="text-sm text-teal-dark">{t(`admin:adminClients.detail.actions.absorb.refusal.${held.refusal.code}`)}</p>
          {held.refusal.tables.length > 0 ? (
            <p className="text-xs text-text-muted" data-testid="admin-client-absorb-blocking-tables">
              {leaf("blockingTables")} {held.refusal.tables.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Every reason this console can see for refusing to offer absorption, in the
 * holder's own snapshot. Substance, not labels: `lifecycleStage` is deliberately
 * not consulted, because it has had no writer since row creation and every paying
 * subscriber in production still reads `lead`.
 *
 * `identityUnknown` blocks rather than passes. A lane that cannot resolve the
 * sign-in fact omits it, and treating unknown as "no account" is exactly how a
 * console offers to absorb somebody's login.
 */
export function absorptionBlockers(holder: Customer360SnapshotResponse): string[] {
  const blockers: string[] = [];
  if (holder.orders.length > 0) blockers.push("orders");
  if (holder.subscriptions.length > 0) blockers.push("subscriptions");
  if (holder.dunningCases.length > 0) blockers.push("dunning");
  if (holder.subject.authUserLinked === undefined) blockers.push("identityUnknown");
  else if (holder.subject.authUserLinked) blockers.push("identity");
  return blockers;
}

/**
 * How the held-address story advances on one settled command.
 *
 * A refused address correction that named a holder opens it; any other outcome of
 * that correction closes it, including the success that ends the whole errand. An
 * absorption only ever updates the story it is part of - it cannot open one -
 * which is why an absorb answer with no current holder is ignored rather than
 * inventing a panel out of a stray response.
 */
export function heldAfter(
  current: HeldAddress | null,
  command: { kind: string; email?: string },
  response: { outcome: string; refusalCode?: string; holderId?: string | null; blockingTables?: string[] },
): HeldAddress | null {
  const refused = response.outcome === "refused" || response.outcome === "conflict";
  if (command.kind === "email") {
    return refused && response.holderId
      ? { holderId: response.holderId, email: command.email ?? "", absorbed: false, refusal: null }
      : null;
  }
  if (command.kind !== "absorb" || !current) return current;
  return refused
    ? { ...current, refusal: { code: response.refusalCode ?? "unknown", tables: response.blockingTables ?? [] } }
    : { ...current, absorbed: true, refusal: null };
}

/**
 * `authUserLinked` says a sign-in identity exists; `hasSignedIn` says anybody ever
 * used it. Both are optional because a lane that cannot resolve them omits them,
 * and unknown must not be rendered as either answer.
 */
function signInContext(subject: Subject): string | null {
  if (subject.authUserLinked === undefined) return null;
  if (!subject.authUserLinked) return "signInContextUnlinked";
  if (subject.hasSignedIn === undefined) return "signInContextUnknown";
  return subject.hasSignedIn ? "signInContextUsed" : "signInContextNeverUsed";
}
