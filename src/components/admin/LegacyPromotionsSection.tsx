import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { AdminPromotion, PromotionStatus } from "@/domains/commerce/adminPromotionsContracts";
import { DEFAULT_MONEY_LANG, formatCurrencyMinor } from "@/lib/currency/formatMinor";
import { ambientSettlementProfile } from "@/lib/currency/platformCurrency";

interface Props {
  title: string;
  promotions: AdminPromotion[] | undefined;
  isLoading: boolean;
  isError: boolean;
  statusPending: boolean;
  onEdit: (promotion: AdminPromotion) => void;
  onStatus: (id: string, status: PromotionStatus) => void;
}

interface MirrorConfirm {
  promotion: AdminPromotion;
  mirrorId: string;
  nextStatus: PromotionStatus;
}

/** Retained v1 editor for flag-off compatibility and code-less automatic promotions. */
export function LegacyPromotionsSection({
  title, promotions, isLoading, isError, statusPending, onEdit, onStatus,
}: Props) {
  // Deliberate human-operator control for system-managed v2 mirror pairs
  // (runbook PROMOTION_V2_PRODUCTION_ACTIVATION step c): status flips only,
  // always behind an explicit confirm dialog.
  const [mirrorConfirm, setMirrorConfirm] = useState<MirrorConfirm | null>(null);
  return (
    <section className="rounded-2xl border border-warm-sand bg-white p-5">
      <h2 className="mb-4 font-display text-[16px] font-semibold text-teal-dark">{title}</h2>
      {isLoading && <p className="text-xs-plus text-text-muted">Ładowanie…</p>}
      {isError && <p className="text-xs-plus text-destructive">Nie udało się wczytać promocji.</p>}
      {promotions && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-text-muted">
            <tr>
              <th className="py-2 font-medium">Kod / nazwa</th>
              <th className="py-2 font-medium">Wartość</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 text-right font-medium">Akcje</th>
            </tr>
          </thead>
          <tbody>
            {promotions.map((promotion) => (
              <tr key={promotion.id} className="border-t border-warm-sand align-middle">
                <td className="py-2">
                  <div className="font-medium text-teal-dark">{promotion.code ?? promotion.name}</div>
                  {promotion.code && promotion.code !== promotion.name && (
                    <div className="text-xs text-text-muted">{promotion.name}</div>
                  )}
                  {promotion.systemManaged && (
                    <div className="mt-1 text-[11px] font-medium text-text-muted">
                      Systemowa · tylko do odczytu
                    </div>
                  )}
                </td>
                <td className="py-2 text-teal-dark/80">{formatValue(promotion)}</td>
                <td className="py-2">
                  <StatusBadge status={promotion.status} />
                  {promotion.v2Mirror && (
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-text-muted">
                      Mirror v2: <StatusBadge status={promotion.v2Mirror.status} />
                    </div>
                  )}
                </td>
                <td className="py-2">
                  {!promotion.readOnly && (
                    <div className="flex justify-end gap-2">
                      <ActionButton onClick={() => onEdit(promotion)}>Edytuj</ActionButton>
                      {statusActions(promotion.status).map((action) => (
                        <ActionButton key={action.status} disabled={statusPending} onClick={() => onStatus(promotion.id, action.status)}>
                          {action.label}
                        </ActionButton>
                      ))}
                    </div>
                  )}
                  {promotion.readOnly && promotion.v2Mirror && (
                    <MirrorStatusAction
                      mirror={promotion.v2Mirror}
                      disabled={statusPending}
                      onRequest={(mirrorId, nextStatus) =>
                        setMirrorConfirm({ promotion, mirrorId, nextStatus })}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <AlertDialog
        open={mirrorConfirm !== null}
        onOpenChange={(open) => !open && setMirrorConfirm(null)}
      >
        <AlertDialogContent className="border-warm-sand bg-offwhite">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-teal-dark">
              {mirrorConfirm?.nextStatus === "active"
                ? "Aktywować mirror v2?"
                : "Wstrzymać mirror v2?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-text-muted">
              {mirrorConfirm?.nextStatus === "active"
                ? `Aktywujesz produkcyjny mirror v2 promocji systemowej „${mirrorConfirm?.promotion.name ?? ""}”. Zmiana natychmiast wpływa na wyceny silnika v2.`
                : `Wstrzymujesz produkcyjny mirror v2 promocji systemowej „${mirrorConfirm?.promotion.name ?? ""}”. Zmiana natychmiast wpływa na wyceny silnika v2.`}
              {" "}Operacja wymaga zalogowanego operatora — konta maszynowe są odrzucane (403).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-warm-sand bg-offwhite text-teal-dark hover:bg-warm-sand">
              Anuluj
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={statusPending}
              onClick={() => {
                if (mirrorConfirm) onStatus(mirrorConfirm.mirrorId, mirrorConfirm.nextStatus);
                setMirrorConfirm(null);
              }}
            >
              {mirrorConfirm?.nextStatus === "active" ? "Aktywuj mirror v2" : "Wstrzymaj mirror v2"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function MirrorStatusAction({ mirror, disabled, onRequest }: {
  mirror: NonNullable<AdminPromotion["v2Mirror"]>;
  disabled: boolean;
  onRequest: (mirrorId: string, nextStatus: PromotionStatus) => void;
}) {
  const active = mirror.status === "active";
  return (
    <div className="flex justify-end gap-2">
      <ActionButton disabled={disabled} onClick={() => onRequest(mirror.id, active ? "paused" : "active")}>
        {active ? "Wstrzymaj mirror v2" : "Aktywuj mirror v2"}
      </ActionButton>
    </div>
  );
}

function statusActions(status: PromotionStatus): Array<{ status: PromotionStatus; label: string }> {
  if (status === "active") return [{ status: "paused", label: "Pauzuj" }, { status: "archived", label: "Archiwizuj" }];
  if (status === "paused" || status === "draft") return [{ status: "active", label: "Aktywuj" }, { status: "archived", label: "Archiwizuj" }];
  return [{ status: "active", label: "Przywróć" }];
}

function formatValue(promotion: AdminPromotion): React.ReactNode {
  const benefit = promotion.semanticBenefit;
  if (benefit.kind === "free_shipping") return "Darmowa wysyłka";
  if (benefit.kind === "percentage") return <span className="font-mono">−{benefit.valuePercent}%</span>;
  if (benefit.kind === "fixed_amount") {
    return <span className="font-mono">−{money(benefit.valueMinor)}</span>;
  }
  if (benefit.kind === "target_percentage") {
    const targets = [...new Set(benefit.unitTargets.map((target) => target.targetMinor))];
    return (
      <div>
        <div className="font-medium">{benefit.valueBps / 100}% od ceny bazowej</div>
        {targets.length === 1 && (
          <div className="font-mono text-xs text-text-muted">{money(targets[0])} za puszkę</div>
        )}
      </div>
    );
  }
  return <span className="text-xs text-warm-amber">Semantyka niedostępna</span>;
}

// No `t()` in this section either, so it formats at DEFAULT_MONEY_LANG in the
// deployment's settlement currency rather than in a hand-written symbol.
function money(minor: number): string {
  return formatCurrencyMinor(minor, {
    currency: ambientSettlementProfile.defaultCurrency,
    locale: DEFAULT_MONEY_LANG,
  });
}

function StatusBadge({ status }: { status: PromotionStatus }) {
  const styles: Record<PromotionStatus, string> = {
    active: "bg-teal/15 text-teal", paused: "bg-warm-amber/15 text-warm-amber",
    archived: "bg-warm-sand text-text-muted", draft: "bg-warm-sand text-text-muted",
  };
  const labels: Record<PromotionStatus, string> = {
    active: "Aktywna", paused: "Wstrzymana", archived: "Archiwalna", draft: "Szkic",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles[status]}`}>{labels[status]}</span>;
}

function ActionButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} className="rounded-md border border-offwhite/15 px-2.5 py-1 text-xs text-text-muted transition hover:bg-offwhite hover:text-teal-dark disabled:opacity-50">{children}</button>;
}
