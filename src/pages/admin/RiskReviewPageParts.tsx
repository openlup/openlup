import { AlertTriangle, Ban, CheckCircle2, Loader2, MessageSquare, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { AdminRiskCaseDetail, AdminRiskCaseSummary } from "@/domains/risk/contracts";
import type { RiskCaseDecision, RiskCaseStatus, RiskSeverity } from "@/domains/risk/types";

const OPEN_STATUSES: RiskCaseStatus[] = ["open", "in_review"];

export function RiskCaseRow({
  riskCase,
  selected,
  onSelect,
}: {
  riskCase: AdminRiskCaseSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      className="cursor-pointer border-offwhite/8 hover:bg-offwhite/5 data-[state=selected]:bg-teal/10"
      onClick={onSelect}
    >
      <TableCell>
        <div className="font-mono text-xs text-offwhite/70">{shortId(riskCase.id)}</div>
        <Badge className="mt-2 bg-offwhite/8 text-offwhite/65">{labelStatus(riskCase.status)}</Badge>
      </TableCell>
      <TableCell>
        <SeverityBadge severity={riskCase.severity} />
        <div className="mt-2 text-sm text-offwhite/55">score {riskCase.score}</div>
      </TableCell>
      <TableCell className="font-mono text-xs text-offwhite/65">
        {riskCase.orderId ? shortId(riskCase.orderId) : "no order"}
      </TableCell>
      <TableCell className="max-w-[360px]">
        <div className="flex flex-wrap gap-1.5">
          {riskCase.reasonCodes.map((code) => (
            <Badge key={code} className="bg-offwhite/8 text-offwhite/60">{code}</Badge>
          ))}
        </div>
      </TableCell>
      <TableCell className="text-offwhite/50">{formatDate(riskCase.updatedAt)}</TableCell>
    </TableRow>
  );
}

export function RiskCaseDetailPanel({
  riskCase,
  loading,
  error,
  note,
  onNoteChange,
  onDecision,
  busy,
  mutationError,
}: {
  riskCase: AdminRiskCaseDetail | null;
  loading: boolean;
  error: boolean;
  note: string;
  onNoteChange: (value: string) => void;
  onDecision: (decision: RiskCaseDecision) => void;
  busy: boolean;
  mutationError: boolean;
}) {
  if (loading) {
    return <aside className="rounded-xl border border-offwhite/8 p-6 text-offwhite/45"><Loader2 className="animate-spin" /></aside>;
  }
  if (error) {
    return <aside className="rounded-xl border border-coral/30 p-6 text-coral/80">Risk case detail failed to load</aside>;
  }
  if (!riskCase) {
    return (
      <aside className="rounded-xl border border-offwhite/8 p-6 text-offwhite/45">
        Select a case to inspect matched rules, sanitized evidence, and reviewer actions.
      </aside>
    );
  }

  const canAct = OPEN_STATUSES.includes(riskCase.status);

  return (
    <aside className="rounded-xl border border-offwhite/8 p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-xs text-offwhite/45">{riskCase.id}</div>
          <h2 className="mt-1 text-lg font-semibold text-offwhite">Review case</h2>
        </div>
        <SeverityBadge severity={riskCase.severity} />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
        <Metric label="Score" value={riskCase.score} />
        <Metric label="Rules" value={riskCase.matchedRules.length} />
      </div>

      <section className="mb-4">
        <h3 className="mb-2 text-sm font-medium text-offwhite">Matched rules</h3>
        <div className="space-y-2">
          {riskCase.matchedRules.map((rule) => (
            <div key={`${rule.code}-${rule.score}`} className="rounded-lg border border-offwhite/8 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-offwhite">{rule.code}</span>
                <span className="text-xs text-offwhite/50">+{rule.score}</span>
              </div>
              <pre className="mt-2 max-h-28 overflow-auto text-xs text-offwhite/45">
                {JSON.stringify(rule.evidence, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-4">
        <h3 className="mb-2 text-sm font-medium text-offwhite">Reviewer note</h3>
        <Textarea
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="Add decision rationale, chargeback evidence note, or escalation context"
          className="border-offwhite/10 bg-void/60 text-offwhite placeholder:text-offwhite/35"
        />
      </section>

      <div className="grid grid-cols-2 gap-2">
        <Button disabled={!canAct || busy} onClick={() => onDecision("approve")}>
          <CheckCircle2 size={16} /> Approve
        </Button>
        <Button disabled={!canAct || busy} variant="destructive" onClick={() => onDecision("block")}>
          <Ban size={16} /> Block
        </Button>
        <Button disabled={!canAct || busy} variant="outline" onClick={() => onDecision("escalate")}>
          <AlertTriangle size={16} /> Escalate
        </Button>
        <Button disabled={!canAct || busy || !note.trim()} variant="outline" onClick={() => onDecision("note")}>
          <MessageSquare size={16} /> Note
        </Button>
      </div>

      {mutationError && <p className="mt-3 text-sm text-coral/80">Decision failed. Retry after checking the case state.</p>}

      <section className="mt-5">
        <h3 className="mb-2 text-sm font-medium text-offwhite">Sanitized evidence</h3>
        <pre className="max-h-72 overflow-auto rounded-lg bg-void/70 p-3 text-xs text-offwhite/50">
          {JSON.stringify(riskCase.evidence, null, 2)}
        </pre>
      </section>
    </aside>
  );
}

export function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-offwhite/8 bg-offwhite/[0.03] px-3 py-2">
      <div className="text-xs text-offwhite/40">{label}</div>
      <div className="mt-1 text-lg font-semibold text-offwhite">{value}</div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: RiskSeverity }) {
  const Icon = severity === "critical" || severity === "high" ? ShieldAlert : AlertTriangle;
  const tone = severity === "critical"
    ? "bg-coral/15 text-coral"
    : severity === "high"
      ? "bg-amber-500/15 text-amber-200"
      : "bg-teal/12 text-teal";
  return (
    <Badge className={tone}>
      <Icon className="mr-1" size={13} />
      {severity}
    </Badge>
  );
}

export function labelStatus(status: RiskCaseStatus | "all"): string {
  return status.replace("_", " ");
}

function shortId(value: string): string {
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
