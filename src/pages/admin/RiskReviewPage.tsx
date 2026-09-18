import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/authContext";
import { decideAdminRiskCase, getAdminRiskCaseDetail, getAdminRiskCases } from "@/domains/risk/riskClient";
import type { AdminRiskCaseDecisionRequest } from "@/domains/risk/contracts";
import type { RiskCaseDecision, RiskCaseStatus } from "@/domains/risk/types";
import { Metric, RiskCaseDetailPanel, RiskCaseRow, labelStatus } from "./RiskReviewPageParts";

const PAGE_SIZE = 25;

export default function RiskReviewPage() {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RiskCaseStatus | "all">("open");
  const [page, setPage] = useState(1);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const request = useMemo(
    () => ({ page, pageSize: PAGE_SIZE, ...(status === "all" ? {} : { status }) }),
    [page, status],
  );

  const casesQuery = useQuery({
    queryKey: ["admin-risk-cases", request, accessToken],
    enabled: Boolean(accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error("Admin session required");
      return getAdminRiskCases(accessToken, request);
    },
    retry: false,
  });

  const detailQuery = useQuery({
    queryKey: ["admin-risk-case-detail", selectedCaseId, accessToken],
    enabled: Boolean(accessToken && selectedCaseId),
    queryFn: async () => {
      if (!accessToken || !selectedCaseId) throw new Error("Risk case selection required");
      return getAdminRiskCaseDetail(accessToken, selectedCaseId);
    },
    retry: false,
  });

  const decisionMutation = useMutation({
    mutationFn: async (decision: RiskCaseDecision) => {
      if (!accessToken || !selectedCaseId) throw new Error("Risk case selection required");
      const request: AdminRiskCaseDecisionRequest = {
        caseId: selectedCaseId,
        decision,
        note: note.trim() || undefined,
        idempotencyKey: `risk-ui:${selectedCaseId}:${decision}:${randomId()}`,
      };
      return decideAdminRiskCase(accessToken, request);
    },
    onSuccess: async (response) => {
      setNote("");
      setSelectedCaseId(response.case.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-risk-cases"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-risk-case-detail", response.case.id] }),
      ]);
    },
  });

  const cases = casesQuery.data?.cases ?? [];
  const totalPages = Math.max(1, Math.ceil((casesQuery.data?.totalCount ?? 0) / PAGE_SIZE));
  const selectedCase = detailQuery.data?.case ?? null;

  return (
    <div data-testid="admin-risk-page" className="p-4 md:p-8">
      <RiskPageHeader
        open={casesQuery.data?.summaryCounts.open ?? 0}
        inReview={casesQuery.data?.summaryCounts.inReview ?? 0}
        highSeverity={casesQuery.data?.summaryCounts.highSeverity ?? 0}
        blocked={casesQuery.data?.summaryCounts.blocked ?? 0}
      />
      <RiskStatusFilters
        status={status}
        totalCount={casesQuery.data?.totalCount ?? 0}
        onChange={(value) => {
          setStatus(value);
          setPage(1);
          setSelectedCaseId(null);
        }}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
        <div className="overflow-x-auto rounded-xl border border-offwhite/8">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow className="border-offwhite/8 hover:bg-transparent">
                <TableHead className="text-offwhite/50">Case</TableHead>
                <TableHead className="text-offwhite/50">Risk</TableHead>
                <TableHead className="text-offwhite/50">Order</TableHead>
                <TableHead className="text-offwhite/50">Reasons</TableHead>
                <TableHead className="text-offwhite/50">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {casesQuery.isLoading ? (
                <RiskTableState text="Loading risk cases" tone="muted" />
              ) : casesQuery.isError ? (
                <RiskTableState text="Risk queue failed to load" tone="error" />
              ) : cases.length === 0 ? (
                <RiskTableState text="No risk cases match this filter" tone="muted" />
              ) : (
                cases.map((riskCase) => (
                  <RiskCaseRow
                    key={riskCase.id}
                    riskCase={riskCase}
                    selected={selectedCaseId === riskCase.id}
                    onSelect={() => setSelectedCaseId(riskCase.id)}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <RiskCaseDetailPanel
          riskCase={selectedCase}
          loading={detailQuery.isLoading}
          error={detailQuery.isError}
          note={note}
          onNoteChange={setNote}
          onDecision={(decision) => decisionMutation.mutate(decision)}
          busy={decisionMutation.isPending}
          mutationError={decisionMutation.isError}
        />
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
          Previous
        </Button>
        <span className="text-sm text-offwhite/45">Page {page} / {totalPages}</span>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

function RiskPageHeader({ open, inReview, highSeverity, blocked }: {
  open: number;
  inReview: number;
  highSeverity: number;
  blocked: number;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div>
        <p className="label-text mb-2 text-teal">Hidden admin surface</p>
        <h1 className="font-display text-xl font-semibold text-offwhite md:text-2xl">Fraud / Risk review</h1>
        <p className="mt-1 max-w-3xl text-sm text-offwhite/50">
          Queue for paid-order risk holds, blocklist hits, velocity signals, PSP AVS/CVC signals,
          promo abuse, and chargeback-ready evidence.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Metric label="Open" value={open} />
        <Metric label="In review" value={inReview} />
        <Metric label="High severity" value={highSeverity} />
        <Metric label="Blocked" value={blocked} />
      </div>
    </div>
  );
}

function RiskStatusFilters({
  status,
  totalCount,
  onChange,
}: {
  status: RiskCaseStatus | "all";
  totalCount: number;
  onChange: (value: RiskCaseStatus | "all") => void;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="flex flex-wrap gap-2">
        {(["open", "in_review", "blocked", "approved", "escalated", "all"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            variant={status === value ? "default" : "outline"}
            size="sm"
            onClick={() => onChange(value)}
          >
            {labelStatus(value)}
          </Button>
        ))}
      </div>
      <div className="text-sm text-offwhite/45">{totalCount} spraw w kolejce</div>
    </div>
  );
}

function RiskTableState({ text, tone }: { text: string; tone: "muted" | "error" }) {
  return (
    <TableRow>
      <TableCell colSpan={5} className={`py-12 text-center ${tone === "error" ? "text-coral/80" : "text-offwhite/40"}`}>
        {tone === "muted" && text.startsWith("Loading") && <Loader2 className="mx-auto mb-2 animate-spin" size={20} />}
        {text}
      </TableCell>
    </TableRow>
  );
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
