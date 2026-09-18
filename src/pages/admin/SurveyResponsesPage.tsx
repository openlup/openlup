import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { getAdminSurveyResponses } from "@/domains/marketing/research/adminSurveyResponsesClient";
import { useAuth } from "@/lib/authContext";
import SurveyResponseTable from "@/components/admin/SurveyResponseTable";
import SurveyResponseJsonModal from "@/components/admin/SurveyResponseJsonModal";
import ProducerSurveyCharts from "@/components/admin/ProducerSurveyCharts";
import ConsumerSurveyCharts from "@/components/admin/ConsumerSurveyCharts";
import { Button } from "@/components/ui/button";
import { downloadCsv, rowsToCsv, todayDateStr, type SurveyRow } from "@/lib/exportSurveyCsv";
import { completedCount, lastResponseAt } from "@/lib/surveyAggregates";
import { Download, RotateCw } from "lucide-react";
import { AdminPaginationControls } from "@/components/admin/AdminPaginationControls";

type SurveyType = "producer" | "consumer";

const REFRESH_MS = 60_000;
const PAGE_SIZE = 50;

export default function SurveyResponsesPage() {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [activeTab, setActiveTab] = useState<SurveyType>("producer");
  const [selected, setSelected] = useState<SurveyRow | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [pages, setPages] = useState<Record<SurveyType, number>>({
    producer: 0,
    consumer: 0,
  });
  const [knownTotals, setKnownTotals] = useState<Record<SurveyType, number | null>>({
    producer: null,
    consumer: null,
  });

  const page = pages[activeTab];
  const surveyQuery = useQuery({
    queryKey: ["admin-survey-responses", activeTab, page, accessToken],
    enabled: Boolean(accessToken),
    queryFn: async ({ signal }) => {
      if (!accessToken) throw new Error("Admin session required");
      const response = await getAdminSurveyResponses(accessToken, {
        surveyType: activeTab,
        page,
        pageSize: PAGE_SIZE,
      }, {
        signal,
      });
      setLastRefresh(new Date());
      return response;
    },
    refetchInterval: () => document.hidden ? false : REFRESH_MS,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!surveyQuery.data) return;
    setKnownTotals((current) => ({
      ...current,
      [activeTab]: surveyQuery.data.totalCount,
    }));
  }, [activeTab, surveyQuery.data]);

  const activeRows = toSurveyRows(surveyQuery.data?.rows ?? []);
  const totalCount = surveyQuery.data?.totalCount ?? knownTotals[activeTab] ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const loading = surveyQuery.isLoading;

  // Visible clock tick for "last refreshed Xs ago" + "last response Xm ago"
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 5_000);
    return () => window.clearInterval(id);
  }, []);

  const secondsAgo = useMemo(() => {
    void tick;
    return Math.floor((Date.now() - lastRefresh.getTime()) / 1000);
  }, [lastRefresh, tick]);

  const completed = useMemo(
    () => completedCount(activeRows, activeTab),
    [activeRows, activeTab],
  );
  const completedPct = activeRows.length === 0
    ? 0
    : Math.round((completed / activeRows.length) * 100);
  const lastResponse = useMemo(() => {
    void tick;
    return lastResponseAt(activeRows);
  }, [activeRows, tick]);

  const handleExport = () => {
    const csv = rowsToCsv(activeRows);
    downloadCsv(`survey_responses_${activeTab}_${todayDateStr()}.csv`, csv);
  };

  const handleManualRefresh = () => {
    void surveyQuery.refetch();
  };

  const setActivePage = (nextPage: number) => {
    setSelected(null);
    setPages((current) => ({
      ...current,
      [activeTab]: Math.max(0, nextPage),
    }));
  };

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-teal-dark">Interzoo 2026 – Survey Responses</h1>
          <p className="text-sm text-text-muted mt-1">
            Auto-refreshes every 60s · Last sync {secondsAgo}s ago
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleManualRefresh}>
            <RotateCw size={16} className="mr-2" />
            Refresh
          </Button>
          <Button onClick={handleExport} disabled={activeRows.length === 0}>
            <Download size={16} className="mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="flex gap-2 border-b border-warm-sand">
        <TabButton
          active={activeTab === "producer"}
          onClick={() => {
            setSelected(null);
            setActiveTab("producer");
          }}
          label="Producer (B2B)"
          count={knownTotals.producer}
        />
        <TabButton
          active={activeTab === "consumer"}
          onClick={() => {
            setSelected(null);
            setActiveTab("consumer");
          }}
          label="Consumer (B2C)"
          count={knownTotals.consumer}
        />
      </div>

      <SummaryStrip
        total={totalCount}
        loaded={activeRows.length}
        completed={completed}
        completedPct={completedPct}
        lastResponse={lastResponse}
      />

      {loading ? (
        <div className="rounded-lg border border-warm-sand bg-offwhite p-12 text-center text-text-muted">
          Loading…
        </div>
      ) : (
        <>
          {activeRows.length > 0 && (
            activeTab === "producer" ? (
              <ProducerSurveyCharts rows={activeRows} />
            ) : (
              <ConsumerSurveyCharts rows={activeRows} />
            )
          )}
          <SurveyResponseTable
            type={activeTab}
            rows={activeRows}
            onViewJson={setSelected}
          />
          <AdminPaginationControls
            page={page}
            totalPages={totalPages}
            label={(currentPage, pages) => `Page ${currentPage + 1} of ${pages}`}
            previousLabel="Previous survey responses page"
            nextLabel="Next survey responses page"
            onPageChange={setActivePage}
          />
        </>
      )}

      <SurveyResponseJsonModal
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        data={selected?.response_data ?? null}
        createdAt={selected?.created_at ?? null}
      />
    </div>
  );
}

function toSurveyRows(rows: Awaited<ReturnType<typeof getAdminSurveyResponses>>["rows"]): SurveyRow[] {
  return rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    response_data: row.response_data,
  }));
}

function SummaryStrip({
  total,
  loaded,
  completed,
  completedPct,
  lastResponse,
}: {
  total: number;
  loaded: number;
  completed: number;
  completedPct: number;
  lastResponse: Date | null;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatCard label="Total responses" value={String(total)} />
      <StatCard
        label="Completed on page"
        value={loaded === 0 ? "–" : `${completed} (${completedPct}%)`}
      />
      <StatCard
        label="Last response"
        value={
          lastResponse
            ? formatDistanceToNow(lastResponse, { addSuffix: true })
            : "–"
        }
      />
      <StatCard label="Loaded rows" value={String(loaded)} hint={`${PAGE_SIZE} per page`} />
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-warm-sand bg-offwhite p-3">
      <div className="text-xs uppercase tracking-wide text-text-muted">
        {label}
      </div>
      <div className="text-lg font-semibold text-teal-dark mt-1 tabular-nums">
        {value}
      </div>
      {hint && (
        <div className="text-[10px] text-text-muted mt-0.5">{hint}</div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-teal text-teal"
          : "border-transparent text-text-muted hover:text-teal-dark/80"
      }`}
    >
      {label} <span className="ml-1 text-xs opacity-70">({count ?? "–"})</span>
    </button>
  );
}
