import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, Search } from "lucide-react";
import { AdminSectionHeader } from "@/components/admin/AdminSurface";
import { AdminPaginationControls } from "@/components/admin/AdminPaginationControls";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/authContext";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { searchAdminClients } from "@/domains/clients/adminClientSearchClient";
import { ClientsPageTable } from "./ClientsPageTable";
import { ClientDetailSheet } from "./ClientDetailSheet";

const PAGE_SIZE = 20;
/** The contract requires a non-empty query, so nothing is requested below this. */
const MIN_QUERY_LENGTH = 2;
const STAGE_FILTERS = ["all", "customer", "inactive"] as const;

type StageFilter = typeof STAGE_FILTERS[number];

export default function ClientsPage() {
  const { t, i18n } = useTranslation("admin");
  const { session } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const accessToken = session?.access_token;
  const urlSearch = searchParams.get("q") ?? "";
  const urlStage = stageFrom(searchParams);
  const urlPage = pageFrom(searchParams);
  const urlSubjectId = searchParams.get("subject")?.trim() || null;

  const [search, setSearch] = useState(() => urlSearch);
  const [stage, setStage] = useState<StageFilter>(() => urlStage);
  const [page, setPage] = useState(() => urlPage);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(() => urlSubjectId);

  useEffect(() => {
    setSearch(urlSearch);
    setStage(urlStage);
    setPage(urlPage);
    setSelectedSubjectId(urlSubjectId);
  }, [urlPage, urlSearch, urlStage, urlSubjectId]);

  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const searchable = debouncedSearch.length >= MIN_QUERY_LENGTH;

  const request = useMemo(
    () => ({ query: debouncedSearch, page, pageSize: PAGE_SIZE, lifecycleStage: stage }),
    [debouncedSearch, page, stage],
  );

  const clientsQuery = useQuery({
    queryKey: ["admin-clients-search", request, accessToken],
    queryFn: ({ signal }) => searchAdminClients(accessToken!, request, { signal }),
    enabled: Boolean(accessToken) && searchable,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });

  const candidates = clientsQuery.data?.candidates ?? [];
  const totalCount = clientsQuery.data?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const updateUrl = (changes: Record<string, string | null>) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      Object.entries(changes).forEach(([key, value]) => {
        if (value) next.set(key, value);
        else next.delete(key);
      });
      return next;
    }, { replace: true });
  };

  const changePage = (nextPage: number) => {
    setPage(nextPage);
    updateUrl({ page: nextPage > 0 ? String(nextPage + 1) : null });
  };

  return (
    <div data-testid="admin-clients-page" className="p-4 text-teal-dark md:p-6 xl:p-8">
      <AdminSectionHeader
        eyebrow={t("admin:adminClients.eyebrow")}
        title={t("admin:adminClients.title")}
        description={t("admin:adminClients.subtitle")}
      />

      <div className="mt-4 space-y-3">
        <div className="relative max-w-md">
          <Search size={16} aria-hidden="true" className="absolute top-1/2 left-3 -translate-y-1/2 text-text-muted" />
          <Input
            className="pl-9"
            type="search"
            value={search}
            aria-label={t("admin:adminClients.searchLabel")}
            placeholder={t("admin:adminClients.searchPlaceholder")}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
              updateUrl({ q: event.target.value || null, page: null });
            }}
          />
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label={t("admin:adminClients.stageFilterLabel")}>
          {STAGE_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={stage === option}
              className={`focus-ring rounded-full border px-3 py-1 text-xs-plus font-semibold transition ${
                stage === option
                  ? "border-teal bg-teal text-white"
                  : "border-warm-sand bg-white text-teal-dark hover:border-teal"
              }`}
              onClick={() => {
                setStage(option);
                setPage(0);
                updateUrl({ stage: option === "all" ? null : option, page: null });
              }}
            >
              {t(`admin:adminClients.stages.${option}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6" aria-live="polite" aria-busy={clientsQuery.isFetching}>
        {!searchable ? (
          <p className="text-sm text-text-muted" data-testid="admin-clients-prompt">
            {t("admin:adminClients.prompt")}
          </p>
        ) : clientsQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="animate-spin text-teal" aria-label={t("admin:adminClients.loading")} />
          </div>
        ) : clientsQuery.isError ? (
          <p className="text-sm text-text-muted" data-testid="admin-clients-error">
            {t("admin:adminClients.error")}
          </p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-text-muted" data-testid="admin-clients-empty">
            {t("admin:adminClients.empty", { query: debouncedSearch })}
          </p>
        ) : (
          <>
            <ClientsPageTable
              candidates={candidates}
              locale={i18n.language}
              onSelect={(subjectId) => {
                setSelectedSubjectId(subjectId);
                updateUrl({ subject: subjectId });
              }}
            />
            <AdminPaginationControls
              page={page}
              totalPages={totalPages}
              previousLabel={t("admin:adminClients.pagination.previous")}
              nextLabel={t("admin:adminClients.pagination.next")}
              label={(current, pages) => t("admin:adminClients.pagination.label", { current: current + 1, pages })}
              onPageChange={changePage}
            />
          </>
        )}
      </div>

      <ClientDetailSheet
        subjectId={selectedSubjectId}
        accessToken={accessToken}
        locale={i18n.language}
        onClose={() => {
          setSelectedSubjectId(null);
          updateUrl({ subject: null });
        }}
      />
    </div>
  );
}

function stageFrom(params: URLSearchParams): StageFilter {
  const value = params.get("stage");
  return STAGE_FILTERS.includes(value as StageFilter) ? value as StageFilter : "all";
}

function pageFrom(params: URLSearchParams): number {
  const value = Number(params.get("page"));
  return Number.isInteger(value) && value > 1 ? value - 1 : 0;
}
