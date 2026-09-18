import { useTranslation } from "react-i18next";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AdminClientsPortableSearchResponse } from "@/domains/clients/portableContracts";
import { formatDate } from "./ordersPageUtils";

type Candidate = AdminClientsPortableSearchResponse["candidates"][number];

export function ClientsPageTable({ candidates, locale, onSelect }: {
  candidates: readonly Candidate[];
  locale: string;
  onSelect: (subjectId: string) => void;
}) {
  const { t } = useTranslation("admin");

  return (
    <Table data-testid="admin-clients-table">
      <TableHeader>
        <TableRow>
          <TableHead>{t("admin:adminClients.table.name")}</TableHead>
          <TableHead>{t("admin:adminClients.table.contact")}</TableHead>
          <TableHead>{t("admin:adminClients.table.stage")}</TableHead>
          <TableHead>{t("admin:adminClients.table.match")}</TableHead>
          <TableHead>{t("admin:adminClients.table.lastActivity")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {candidates.map((candidate) => (
          <ClientRow
            key={candidate.subject.subjectId}
            candidate={candidate}
            locale={locale}
            onSelect={() => onSelect(candidate.journeyLookup.subjectId)}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function ClientRow({ candidate, locale, onSelect }: {
  candidate: Candidate;
  locale: string;
  onSelect: () => void;
}) {
  const { t } = useTranslation("admin");
  const { subject } = candidate;
  const matchReason = candidateMatchReason(candidate);
  const matchLabels: Record<string, string> = {
    subject_id: t("admin:adminClients.matches.subject_id"),
    email: t("admin:adminClients.matches.email"),
    phone: t("admin:adminClients.matches.phone"),
    name: t("admin:adminClients.matches.name"),
    order: t("admin:adminClients.matches.order"),
    subscription: t("admin:adminClients.matches.subscription"),
    text: t("admin:adminClients.matches.text"),
  };

  return (
    <TableRow data-testid={`admin-clients-row-${subject.subjectId}`}>
      <TableCell>
        <button
          type="button"
          className="focus-ring rounded-sm text-left font-semibold text-teal-dark hover:underline"
          aria-label={t("admin:adminClients.table.openCard", {
            name: subject.displayName ?? subject.email ?? subject.subjectId,
          })}
          onClick={onSelect}
        >
          {subject.displayName ?? t("admin:adminClients.table.unnamed")}
        </button>
      </TableCell>
      <TableCell className="text-sm">
        <span className="block">{subject.email ?? "-"}</span>
        {subject.phone ? <span className="block text-text-muted">{subject.phone}</span> : null}
      </TableCell>
      <TableCell>
        {t(`admin:adminClients.stages.${subject.lifecycleStage}`)}
      </TableCell>
      <TableCell className="text-sm">
        <span className="block font-medium text-teal-dark">
          {matchLabels[matchReason] ?? matchLabels.text}
        </span>
        <span className="text-xs text-text-muted">
          {t(`admin:adminClients.confidence.${candidate.confidence}`)}
        </span>
      </TableCell>
      <TableCell className="text-sm text-text-muted">
        {subject.lastActivityAt ? formatDate(subject.lastActivityAt, locale) : "-"}
      </TableCell>
    </TableRow>
  );
}

function candidateMatchReason(candidate: Candidate) {
  const reason = candidate.managedOverlay?.matchReason;
  return reason === "id" ? "subject_id" :
    ["email", "phone", "name", "order", "subscription", "text"].includes(String(reason))
      ? String(reason)
      : candidate.matchedBy;
}
