import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/lib/authContext';
import {
  getAdminEmailSendEvents,
  getAdminEmailSends,
} from '@/domains/communications/adminEmailSendsClient';
import { EmailSendDetailPanel } from './email-sends/EmailSendDetailPanel';
import { EmailSendsStats } from './email-sends/EmailSendsStats';
import { EmailSendsTable } from './email-sends/EmailSendsTable';
import { PAGE_SIZE } from './email-sends/types';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

export default function EmailSendsPage() {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [search, setSearch] = useState('');
  const [templateFilter, setTemplateFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search, 350);

  const { data: emailSendsData, isError, isLoading } = useQuery({
    queryKey: ['email-sends-bff', statusFilter, templateFilter, debouncedSearch, page, accessToken],
    enabled: Boolean(accessToken),
    queryFn: async ({ signal }) => {
      if (!accessToken) throw new Error('Admin session required');
      return getAdminEmailSends(accessToken, {
        status: statusFilter,
        template: templateFilter,
        search: debouncedSearch,
        page,
        pageSize: PAGE_SIZE,
      }, {
        signal,
      });
    },
  });

  const stats = {
    totalSent: emailSendsData?.stats.totalSent ?? 0,
    delivered: emailSendsData?.stats.delivered ?? 0,
    opened: emailSendsData?.stats.opened ?? 0,
    clicked: emailSendsData?.stats.clicked ?? 0,
  };
  const templateSlugs = emailSendsData?.templateSlugs ?? [];
  const sends = emailSendsData?.sends ?? [];
  const totalCount = emailSendsData?.totalCount ?? 0;
  const eventsSummary = emailSendsData?.eventsSummary ?? {};

  const { data: expandedEvents = [] } = useQuery({
    queryKey: ['email-events-detail-bff', expandedId, accessToken],
    queryFn: async ({ signal }) => {
      if (!expandedId || !accessToken) return [];
      const response = await getAdminEmailSendEvents(accessToken, { sendId: expandedId }, { signal });
      return response.events;
    },
    enabled: Boolean(expandedId && accessToken),
  });

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const expandedSend = sends.find((send) => send.id === expandedId) ?? null;
  const tableStatusMessage = !accessToken
    ? "Brak aktywnej sesji administratora. Odśwież logowanie i spróbuj ponownie."
    : isError
      ? "Nie udało się pobrać wysyłek maili."
      : null;

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6">
        <h1 className="font-display text-xl font-semibold tracking-tight md:text-2xl">Wysyłki maili</h1>
        <p className="mt-1 text-sm text-text-muted">{totalCount} łącznie</p>
      </div>

      <EmailSendsStats stats={stats} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
          <Input
            placeholder="Szukaj po emailu lub imieniu testera..."
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            className="border-warm-sand bg-offwhite pl-9 text-teal-dark placeholder:text-text-muted"
          />
        </div>

        <Select
          value={templateFilter}
          onValueChange={(value) => {
            setTemplateFilter(value);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-48 border-warm-sand bg-offwhite text-teal-dark">
            <SelectValue placeholder="Wszystkie szablony" />
          </SelectTrigger>
          <SelectContent className="border-warm-sand bg-white text-teal-dark">
            <SelectItem value="all">Wszystkie szablony</SelectItem>
            {templateSlugs.map((slug) => (
              <SelectItem key={slug} value={slug}>{slug}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-48 border-warm-sand bg-offwhite text-teal-dark">
            <SelectValue placeholder="Wszystkie statusy" />
          </SelectTrigger>
          <SelectContent className="border-warm-sand bg-white text-teal-dark">
            <SelectItem value="all">Wszystkie statusy</SelectItem>
            <SelectItem value="sent">wysłano</SelectItem>
            <SelectItem value="delivered">dostarczono</SelectItem>
            <SelectItem value="bounced">odrzucono</SelectItem>
            <SelectItem value="complained">zgłoszono</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <EmailSendsTable
        sends={sends}
        isLoading={isLoading}
        statusMessage={tableStatusMessage}
        expandedId={expandedId}
        eventsSummary={eventsSummary}
        onToggleExpanded={(id) => setExpandedId(expandedId === id ? null : id)}
      />

      <EmailSendDetailPanel send={expandedSend} events={expandedEvents} />

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-text-muted">Page {page + 1} of {totalPages}</p>
          <div className="flex gap-2">
            <button
              disabled={page === 0}
              onClick={() => setPage((current) => current - 1)}
              className="rounded-lg border border-warm-sand px-3 py-1.5 text-sm text-text-muted hover:bg-offwhite disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage((current) => current + 1)}
              className="rounded-lg border border-warm-sand px-3 py-1.5 text-sm text-text-muted hover:bg-offwhite disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
