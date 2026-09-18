import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import B2BInquiryDetailSheet from '@/components/admin/B2BInquiryDetailSheet';
import { getAdminB2BInquiries } from '@/domains/partners/adminB2BInquiryClient';
import type { PartnersB2BInquiry } from '@/domains/partners/contracts';
import { useAuth } from '@/lib/authContext';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  ALL_STATUSES,
  STATUS_COLORS,
  STATUS_LABELS,
  formatCountry,
} from '@/pages/admin/b2b/b2bInquiryStatus';

const PAGE_SIZE = 50;

export default function B2BInquiriesPage() {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<PartnersB2BInquiry | null>(null);
  const debouncedSearch = useDebouncedValue(search, 350);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-b2b-inquiries', statusFilter, debouncedSearch, page, accessToken],
    enabled: Boolean(accessToken),
    queryFn: async ({ signal }) => {
      if (!accessToken) throw new Error('Admin session required');
      return getAdminB2BInquiries(accessToken, {
        status: statusFilter,
        search: debouncedSearch.trim(),
        page,
        pageSize: PAGE_SIZE,
      }, {
        signal,
      });
    },
  });

  const inquiries = data?.inquiries ?? [];
  const totalCount = data?.totalCount ?? 0;
  const newCount = data?.newCount ?? 0;

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-xl font-semibold tracking-tight md:text-2xl">B2B Inquiries</h1>
            {newCount > 0 && (
              <Badge variant="outline" className="bg-sky-500/15 text-sky-400 border-sky-500/30 text-xs">
                {newCount} nowych
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-text-muted">{totalCount} łącznie</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
          <Input
            placeholder="Szukaj po firmie, emailu, nazwisku..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="border-warm-sand bg-offwhite pl-9 text-teal-dark placeholder:text-text-muted"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
          <SelectTrigger className="w-52 border-warm-sand bg-offwhite text-teal-dark">
            <SelectValue placeholder="Wszystkie statusy" />
          </SelectTrigger>
          <SelectContent className="border-warm-sand bg-white text-teal-dark">
            <SelectItem value="all">Wszystkie statusy</SelectItem>
            {ALL_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="-mx-4 overflow-x-auto border border-warm-sand md:mx-0 md:rounded-xl md:overflow-hidden">
        <Table className="min-w-[860px] md:min-w-0">
          <TableHeader>
            <TableRow className="border-warm-sand hover:bg-transparent">
              <TableHead className="text-text-muted">Data</TableHead>
              <TableHead className="text-text-muted">Firma</TableHead>
              <TableHead className="text-text-muted">Kraj</TableHead>
              <TableHead className="text-text-muted">Typ</TableHead>
              <TableHead className="text-text-muted">Kontakt</TableHead>
              <TableHead className="text-text-muted">Status</TableHead>
              <TableHead className="text-text-muted">Pipedrive</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-text-muted py-12">Ładowanie...</TableCell>
              </TableRow>
            ) : inquiries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-text-muted py-12">Brak zapytań</TableCell>
              </TableRow>
            ) : (
              inquiries.map((inq) => (
                <TableRow
                  key={inq.id}
                  className="border-offwhite/6 cursor-pointer hover:bg-white"
                  onClick={() => setSelected(inq)}
                >
                  <TableCell className="text-text-muted text-sm whitespace-nowrap">
                    {new Date(inq.created_at).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </TableCell>
                  <TableCell className="font-medium text-teal-dark">{inq.company}</TableCell>
                  <TableCell className="text-text-muted text-sm">{formatCountry(inq.country)}</TableCell>
                  <TableCell className="text-text-muted text-sm">{inq.company_type}</TableCell>
                  <TableCell className="text-text-muted text-sm">
                    <div>{inq.first_name} {inq.last_name}</div>
                    <div className="text-text-muted text-xs">{inq.business_email}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs ${STATUS_COLORS[inq.status] ?? ''}`}>
                      {STATUS_LABELS[inq.status] ?? inq.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-text-muted text-xs">
                    {inq.pipedrive_deal_id ? (
                      <span className="text-teal">#{inq.pipedrive_deal_id}</span>
                    ) : (
                      'pending'
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-text-muted">Strona {page + 1} z {totalPages}</p>
          <div className="flex gap-2">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-lg border border-warm-sand px-3 py-1.5 text-sm text-text-muted hover:bg-offwhite disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-warm-sand px-3 py-1.5 text-sm text-text-muted hover:bg-offwhite disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      <B2BInquiryDetailSheet inquiry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
