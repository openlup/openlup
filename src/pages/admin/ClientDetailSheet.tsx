import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CalendarClock, Loader2, Mail, MapPin, Pause, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import {
  absorbOperatorLead,
  applyOperatorSubscriptionAction,
  correctOperatorSubjectEmail,
  correctOperatorSubjectPhone,
  getCustomer360Snapshot,
} from "@/domains/support/customer360Client";
import type { Customer360ContactHealth, Customer360SnapshotResponse } from "@/domains/support/customer360Contracts";
import { ActionButton } from "./OrderDetailBlocks";
import { ClientAddressChange, type ChangeAddressPayload } from "./ClientAddressChange";
import { ClientContactCorrection, heldAfter, type HeldAddress } from "./ClientContactCorrection";
import { formatDate } from "./ordersPageUtils";

const PAUSE_PRESETS = ["2_weeks", "1_month", "indefinite"] as const;
const DAY_MS = 86_400_000;

/** `kind` names the copy, the test id and the dialog; `verb` is the authority's vocabulary. */
const SUBSCRIPTION_ACTIONS = [
  { kind: "pause", verb: "pause", icon: Pause },
  { kind: "resume", verb: "resume", icon: Play },
  { kind: "reschedule", verb: "slide_next_cycle", icon: CalendarClock },
  { kind: "changeAddress", verb: "change_shipping_address", icon: MapPin },
] as const;

type PausePreset = (typeof PAUSE_PRESETS)[number];
type ConfirmKind = (typeof SUBSCRIPTION_ACTIONS)[number]["kind"] | "correctEmail" | "correctPhone" | "absorbLead";
type ActionExtras = { pausePreset?: PausePreset; newNextCycleAt?: string; slideMinDays?: number } | ChangeAddressPayload;

/**
 * `expectedVersion` is optimistic concurrency against `subscriptions.template_version`, which
 * the card reports as an optional `templateVersion`: a deployment whose lane cannot resolve it
 * omits the key rather than guessing. Absent therefore means unknown, and every subscription
 * action stays disabled with the reason stated on hover and on focus, exactly as an unlinked
 * account gates the address correction; see `signInCopy`. A default would either clobber a
 * concurrent subscriber edit or make every operator command fail as a version conflict, both
 * of which are worse than an honestly unavailable button.
 */
type OperatorSubscription = Customer360SnapshotResponse["subscriptions"][number];

/**
 * The four response unions share exactly the fields this console has to act on:
 * the outcome, the reason when there is one, and - only on the address
 * correction - who was already holding the address, which is what turns that
 * refusal into the absorption offer rather than a dead end.
 */
type CommandResult = { outcome: string; refusalCode?: string; holderId?: string | null; blockingTables?: string[] };
type OperatorCommand =
  | { kind: "subscription"; input: Parameters<typeof applyOperatorSubscriptionAction>[1] }
  | { kind: "email"; input: Parameters<typeof correctOperatorSubjectEmail>[1] }
  | { kind: "phone"; input: Parameters<typeof correctOperatorSubjectPhone>[1] }
  | { kind: "absorb"; input: Parameters<typeof absorbOperatorLead>[1] };

export function ClientDetailSheet({ subjectId, accessToken, locale, onClose }: {
  subjectId: string | null; accessToken: string | undefined; locale: string; onClose: () => void;
}) {
  const { t } = useTranslation("admin");
  const snapshotQuery = useQuery({
    queryKey: ["admin-client-360", subjectId, accessToken],
    queryFn: ({ signal }) => getCustomer360Snapshot(accessToken!, subjectId!, { signal }),
    enabled: Boolean(accessToken && subjectId),
    retry: false,
  });
  const snapshot = snapshotQuery.data;

  return (
    <Sheet open={Boolean(subjectId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent data-testid="admin-client-detail-sheet" className="w-full overflow-y-auto border-warm-sand bg-white text-teal-dark sm:max-w-2xl">
        <SheetHeader>
          <p className="label-text text-teal">{t("admin:adminClients.detail.eyebrow")}</p>
          <SheetTitle>
            {snapshot?.subject.displayName ?? snapshot?.subject.email ?? t("admin:adminClients.detail.title")}
          </SheetTitle>
        </SheetHeader>

        {snapshotQuery.isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="animate-spin text-teal" aria-label={t("admin:adminClients.detail.loading")} /></div>
        ) : snapshotQuery.isError ? (
          <p className="py-6 text-sm text-text-muted" data-testid="admin-client-detail-error">{t("admin:adminClients.detail.error")}</p>
        ) : snapshot ? (
          // Keyed on the subject so switching customers cannot carry one person's typed
          // address, chosen date or minted idempotency key into another person's card.
          <ClientDetailBody key={subjectId ?? "none"} snapshot={snapshot} locale={locale} accessToken={accessToken} subjectId={subjectId} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ClientDetailBody({ snapshot, locale, accessToken, subjectId }: {
  snapshot: Customer360SnapshotResponse; locale: string; accessToken: string | undefined; subjectId: string | null;
}) {
  const { t } = useTranslation("admin");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { subject } = snapshot;
  // The field states which of the four sign-in facts holds; the correction section
  // owns its own copy of the same read, because it phrases them as context not a gate.
  const signInField = subject.authUserLinked === undefined ? null
    : !subject.authUserLinked ? "signInUnlinked"
    : subject.hasSignedIn === undefined ? "signInLinkedUnknown"
    : subject.hasSignedIn ? "signInLinked" : "signInCreatedWithOrder";
  const [presets, setPresets] = useState<Record<string, PausePreset>>({});
  const [slideDates, setSlideDates] = useState<Record<string, string>>({});
  const [newEmail, setNewEmail] = useState("");
  const [result, setResult] = useState<{ refused: boolean; message: string } | null>(null);
  const [held, setHeld] = useState<HeldAddress | null>(null);
  // The holder's own card, read through the same snapshot endpoint and cache key the
  // sheet already uses, so the panel can say what the record is before an operator
  // agrees to fold it in. Only ever fetched once a refusal has named a holder.
  const holderQuery = useQuery({
    queryKey: ["admin-client-360", held?.holderId, accessToken],
    queryFn: ({ signal }) => getCustomer360Snapshot(accessToken!, held!.holderId, { signal }),
    enabled: Boolean(accessToken && held), retry: false,
  });
  const keysRef = useRef(new Map<string, { fingerprint: string; key: string }>());
  const mintedRef = useRef(0);
  const inFlightRef = useRef(false);

  const runCommand = useMutation({
    mutationFn: async (command: OperatorCommand): Promise<CommandResult> => {
      if (!accessToken) throw new Error("Admin session required");
      if (command.kind === "subscription") return applyOperatorSubscriptionAction(accessToken, command.input);
      if (command.kind === "email") return correctOperatorSubjectEmail(accessToken, command.input);
      if (command.kind === "absorb") return absorbOperatorLead(accessToken, command.input);
      return correctOperatorSubjectPhone(accessToken, command.input);
    },
    // A refusal and a conflict both resolve successfully at the transport level, and neither
    // may read as a success: they take the error surface and the destructive toast, and the
    // card is not re-read, because nothing about the customer changed.
    onSuccess: async (response, command) => {
      const refused = response.outcome === "refused" || response.outcome === "conflict";
      setHeld((current) => heldAfter(current, { kind: command.kind, email: command.kind === "email" ? command.input.newEmail : undefined }, response));
      const message = refused
        ? t("admin:adminClients.detail.actions.refused", { code: response.refusalCode ?? "unknown" })
        : t(`admin:adminClients.detail.actions.outcome.${response.outcome}`);
      setResult({ refused, message });
      toast(refused ? { title: message, variant: "destructive" } : { title: message });
      if (refused) return;
      setNewEmail("");
      await queryClient.invalidateQueries({ queryKey: ["admin-client-360", subjectId, accessToken] });
    },
    onError: (error) => {
      const reason = error instanceof Error && error.message
        ? error.message
        : t("admin:adminClients.detail.actions.unknownReason");
      const message = t("admin:adminClients.detail.actions.failed", { reason });
      setResult({ refused: true, message });
      toast({ title: message, variant: "destructive" });
    },
    onSettled: () => {
      inFlightRef.current = false;
    },
  });
  const busy = runCommand.isPending;

  /**
   * One idempotency key per (target, verb, observed state). A double click or a retry of the
   * same command reuses the key the authority already deduplicates, so it can never become
   * two commands; a genuinely new command, sent after the card re-read and the status, cycle
   * date or version moved, mints a fresh one.
   */
  const idempotencyKey = (slot: string, fingerprint: string) => {
    const existing = keysRef.current.get(slot);
    if (existing?.fingerprint === fingerprint) return existing.key;
    mintedRef.current += 1;
    const key = ["admin-support", slot, Date.now().toString(36), mintedRef.current.toString(36)].join(":");
    keysRef.current.set(slot, { fingerprint, key });
    return key;
  };

  const send = (command: OperatorCommand) => {
    if (busy || inFlightRef.current) return;
    inFlightRef.current = true;
    runCommand.mutate(command);
  };

  return (
    <div className="space-y-6 py-4">
      <ContactHealthNotice health={snapshot.contactHealth} locale={locale} />

      <section className="space-y-2">
        <h3 className="label-text text-teal">{t("admin:adminClients.detail.identity")}</h3>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label={t("admin:adminClients.detail.email")} value={subject.email} />
          <Field label={t("admin:adminClients.detail.stage")} value={t(`admin:adminClients.stages.${subject.lifecycleStage}`)} />
          <Field label={t("admin:adminClients.detail.firstSeen")} value={subject.firstSeenAt ? formatDate(subject.firstSeenAt, locale) : null} />
          <Field label={t("admin:adminClients.detail.lastActivity")} value={subject.lastActivityAt ? formatDate(subject.lastActivityAt, locale) : null} />
          {signInField === null ? null : (
            <Field label={t("admin:adminClients.detail.signIn")} value={t(`admin:adminClients.detail.${signInField}`)} />
          )}
        </dl>
      </section>

      <CountSection counts={[
        { label: t("admin:adminClients.detail.orders"), value: snapshot.orders.length },
        { label: t("admin:adminClients.detail.subscriptions"), value: snapshot.subscriptions.length },
        { label: t("admin:adminClients.detail.openDunning"), value: snapshot.dunningCases.length },
      ]} />

      {result ? (
        <p
          data-testid={result.refused ? "admin-client-action-error" : "admin-client-action-applied"}
          className={`rounded-control border p-3 text-sm text-teal-dark ${result.refused ? "border-destructive/40 bg-destructive/5" : "border-warm-sand"}`}
        >{result.message}</p>
      ) : null}

      <section className="space-y-2">
        <h3 className="label-text text-teal">{t("admin:adminClients.detail.subscriptionsHeading")}</h3>
        {snapshot.subscriptions.length === 0 ? (
          <p className="text-sm text-text-muted">{t("admin:adminClients.detail.noSubscriptions")}</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {snapshot.subscriptions.map((subscription: OperatorSubscription) => {
              const id = subscription.subscriptionId;
              const version = subscription.templateVersion;
              const noVersion = version === undefined ? t("admin:adminClients.detail.actions.noVersion") : null;
              const preset = presets[id] ?? PAUSE_PRESETS[0];
              const slideDate = slideDates[id] ?? "";
              const run = (verb: (typeof SUBSCRIPTION_ACTIONS)[number]["verb"], payload: ActionExtras | undefined) => {
                if (version === undefined) return;
                const fingerprint = JSON.stringify([payload, version, subscription.status, subscription.nextCycleAt]);
                send({ kind: "subscription", input: {
                  action: "apply_subscription_action", subscriptionId: id, subscriptionAction: verb,
                  expectedVersion: version, idempotencyKey: idempotencyKey(`subscription:${id}:${verb}`, fingerprint),
                  ...(payload ? { payload } : {}),
                } });
              };
              return (
                <li key={id} data-testid={`admin-client-subscription-${id}`} className="space-y-3 rounded-control border border-warm-sand p-3">
                  <div className="flex justify-between gap-4">
                    <span>{subscription.status}</span>
                    <span className="text-text-muted">{subscription.nextCycleAt
                      ? t("admin:adminClients.detail.nextCycle", { date: formatDate(subscription.nextCycleAt, locale) })
                      : t("admin:adminClients.detail.noNextCycle")}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="label-text text-text-muted" htmlFor={`pause-preset-${id}`}>{t("admin:adminClients.detail.actions.pausePresetLabel")}</label>
                    <select
                      id={`pause-preset-${id}`} data-testid={`admin-client-pause-preset-${id}`} value={preset}
                      onChange={(event) => setPresets((current) => ({ ...current, [id]: event.target.value as PausePreset }))}
                      className="focus-ring rounded-md border border-warm-sand px-2 py-1 text-xs text-teal-dark"
                    >
                      {PAUSE_PRESETS.map((value) => <option key={value} value={value}>{t(`admin:adminClients.detail.actions.pausePreset.${value}`)}</option>)}
                    </select>
                    <label className="label-text text-text-muted" htmlFor={`slide-date-${id}`}>{t("admin:adminClients.detail.actions.rescheduleDateLabel")}</label>
                    <Input
                      id={`slide-date-${id}`} data-testid={`admin-client-slide-date-${id}`} type="date" className="h-8 w-auto text-xs"
                      min={dayInput(1)} max={dayInput(59)} value={slideDate}
                      onChange={(event) => setSlideDates((current) => ({ ...current, [id]: event.target.value }))}
                    />
                    {/* `slideMinDays: 1` is the narrow operator-only band, and the end of the chosen UTC
                        day is what makes tomorrow reachable inside it: the authority refuses any target
                        closer than now + slideMinDays, and the cycle's own time of day would fall under
                        it. Resume carries no payload at all rather than an empty one. */}
                    {SUBSCRIPTION_ACTIONS.map(({ kind, verb, icon }) => {
                      if (kind === "changeAddress") return <ClientAddressChange key={kind} icon={icon} busy={busy} blockedReason={noVersion} subscriptionId={id}
                        currentAddressId={subscription.shippingAddressId} addresses={snapshot.addresses} confirm={confirmCopy(t, kind)} onSubmit={(payload) => run(verb, payload)} />;
                      const blocked = noVersion
                        ?? (kind === "reschedule" && slideDate === "" ? t("admin:adminClients.detail.actions.needDate") : null);
                      return (
                        <ActionButton
                          key={kind} icon={icon} label={t(`admin:adminClients.detail.actions.${kind}`)}
                          disabled={busy || blocked !== null} disabledReason={blocked}
                          confirm={confirmCopy(t, kind)} testId={`admin-client-${kind}-${id}`}
                          onClick={() => run(verb, kind === "pause"
                            ? { pausePreset: preset }
                            : kind === "reschedule"
                              ? { newNextCycleAt: `${slideDate}T23:59:00.000Z`, slideMinDays: 1 }
                              : undefined)}
                        />
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ClientContactCorrection
        subject={subject} busy={busy} locale={locale}
        held={held} holder={holderQuery.data ?? null} holderPending={holderQuery.isPending && Boolean(held)}
        confirmCopy={(kind) => confirmCopy(t, kind)}
        onAbsorbLead={({ leadId, expectedLeadEmail }) => send({ kind: "absorb", input: {
          action: "absorb_lead", subjectId: subject.subjectId, leadId, expectedLeadEmail,
          idempotencyKey: idempotencyKey(`absorb:${subject.subjectId}:${leadId}`, expectedLeadEmail),
        } })}
        onCorrectEmail={({ expectedEmail, newEmail }) => send({ kind: "email", input: {
          action: "correct_email", subjectId: subject.subjectId, expectedEmail, newEmail,
          idempotencyKey: idempotencyKey(`email:${subject.subjectId}`, JSON.stringify([expectedEmail, newEmail])),
        } })}
        onCorrectPhone={({ expectedPhone, newPhone }) => send({ kind: "phone", input: {
          action: "correct_phone", subjectId: subject.subjectId, expectedPhone, newPhone,
          idempotencyKey: idempotencyKey(`phone:${subject.subjectId}`, JSON.stringify([expectedPhone, newPhone])),
        } })}
      />
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

function confirmCopy(t: Translate, kind: ConfirmKind) {
  const leaf = (name: string) => t(`admin:adminClients.detail.actions.confirm.${kind}.${name}`);
  return {
    title: leaf("title"), description: leaf("body"), actionLabel: leaf("action"),
    cancelLabel: t("admin:adminClients.detail.actions.cancel"),
  };
}

/** `YYYY-MM-DD`, `days` from now, for the date input's own bounds. */
function dayInput(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

/** The badge the bounce incident was missing: it either lights, or it does not. */
function ContactHealthNotice({ health, locale }: { health: Customer360ContactHealth | undefined; locale: string }) {
  const { t } = useTranslation("admin");
  if (!health) return null;

  if (health.reachable) {
    return (
      <p className="text-sm text-text-muted" data-testid="admin-client-contact-health-ok">
        {t(`admin:adminClients.contactHealth.${health.lastTerminalStatus === null ? "noEvidence" : "reachable"}`)}
      </p>
    );
  }

  return (
    <div className="space-y-1 rounded-control border border-destructive/40 bg-destructive/5 p-3" data-testid="admin-client-contact-health-unreachable">
      <Badge variant="destructive">{t("admin:adminClients.contactHealth.unreachable")}</Badge>
      <p className="text-sm text-teal-dark">
        {t(`admin:adminClients.contactHealth.reason.${health.lastTerminalStatus ?? "failed"}`)}
        {health.lastTerminalAt ? ` ${t("admin:adminClients.contactHealth.at", { date: formatDate(health.lastTerminalAt, locale) })}` : ""}
      </p>
    </div>
  );
}

function CountSection({ counts }: { counts: Array<{ label: string; value: number }> }) {
  return (
    <section className="grid grid-cols-3 gap-3">
      {counts.map((count) => (
        <div key={count.label} className="rounded-control border border-warm-sand p-3">
          <p className="label-text text-text-muted">{count.label}</p>
          <p className="text-lg font-bold text-teal-dark">{count.value}</p>
        </div>
      ))}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return <div><dt className="label-text text-text-muted">{label}</dt><dd className="mt-0.5 text-sm text-teal-dark">{value ?? "-"}</dd></div>;
}
