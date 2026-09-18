import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { ExternalLink, Building2, Mail, Phone, Globe, Tag, StickyNote, Calendar, Hash, type LucideIcon } from 'lucide-react';
import { updateAdminB2BInquiryStatus } from '@/domains/partners/adminB2BInquiryClient';
import type { PartnersB2BInquiry, PartnersB2BInquiryStatus } from '@/domains/partners/contracts';
import { useAuth } from '@/lib/authContext';
import { STATUS_COLORS, STATUS_LABELS, formatCountry } from '@/pages/admin/b2b/b2bInquiryStatus';

function Field({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: React.ReactNode }) {
  if (!value) return null;
  return (
    <div className="flex gap-3">
      <Icon size={16} className="mt-0.5 shrink-0 text-text-muted" />
      <div>
        <dt className="text-xs text-text-muted">{label}</dt>
        <dd className="mt-0.5 text-sm text-teal-dark">{value}</dd>
      </div>
    </div>
  );
}

const NEXT_STATUSES: Record<string, PartnersB2BInquiryStatus[]> = {
  new: ['contacted', 'qualified', 'disqualified'],
  contacted: ['qualified', 'disqualified'],
  qualified: ['closed_won', 'closed_lost'],
  disqualified: ['new'],
  closed_won: [],
  closed_lost: ['new'],
};

interface Props {
  inquiry: PartnersB2BInquiry | null;
  onClose: () => void;
}

export default function B2BInquiryDetailSheet({ inquiry, onClose }: Props) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const queryClient = useQueryClient();

  const updateStatus = useMutation({
    mutationFn: async (status: PartnersB2BInquiryStatus) => {
      if (!accessToken) throw new Error('Admin session required');
      if (!inquiry) throw new Error('B2B inquiry required');
      await updateAdminB2BInquiryStatus(accessToken, { id: inquiry.id, status });
    },
    onSuccess: (_, status) => {
      toast.success(`Status zmieniony na „${STATUS_LABELS[status] ?? status}"`);
      queryClient.invalidateQueries({ queryKey: ['admin-b2b-inquiries'] });
    },
    onError: () => toast.error('Nie udało się zmienić statusu'),
  });

  if (!inquiry) return null;

  const nextStatuses = NEXT_STATUSES[inquiry.status] ?? [];
  const pipedriveUrl = inquiry.pipedrive_deal_id
    ? `https://app.pipedrive.com/deal/${inquiry.pipedrive_deal_id}`
    : null;

  return (
    <Sheet open={!!inquiry} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full max-w-lg border-warm-sand bg-white text-teal-dark overflow-y-auto">
        <SheetHeader className="mb-6">
          <div className="flex items-start gap-3">
            <Building2 size={20} className="mt-1 shrink-0 text-text-muted" />
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-teal-dark text-lg leading-tight">{inquiry.company}</SheetTitle>
              <p className="mt-1 text-sm text-text-muted">{formatCountry(inquiry.country)} · {inquiry.company_type ?? '–'}</p>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Badge variant="outline" className={`text-xs ${STATUS_COLORS[inquiry.status] ?? ''}`}>
              {STATUS_LABELS[inquiry.status] ?? inquiry.status}
            </Badge>
            <span className="text-xs text-text-muted">
              {new Date(inquiry.created_at).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          </div>
        </SheetHeader>

        {/* Status actions */}
        {nextStatuses.length > 0 && (
          <div className="mb-6">
            <p className="mb-2 text-xs font-medium text-text-muted uppercase tracking-wide">Zmień status</p>
            <div className="flex flex-wrap gap-2">
              {nextStatuses.map((s) => (
                <button
                  key={s}
                  onClick={() => updateStatus.mutate(s)}
                  disabled={updateStatus.isPending}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-80 disabled:opacity-40 ${STATUS_COLORS[s] ?? 'border-offwhite/20 text-text-muted'}`}
                >
                  {STATUS_LABELS[s] ?? s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Contact */}
        <section className="mb-6">
          <p className="mb-3 text-xs font-medium text-text-muted uppercase tracking-wide">Kontakt</p>
          <dl className="space-y-3">
            <Field icon={Mail} label="Imię i nazwisko" value={`${inquiry.first_name} ${inquiry.last_name}`} />
            <Field icon={Mail} label="Email" value={
              <a href={`mailto:${inquiry.business_email}`} className="text-teal hover:underline">
                {inquiry.business_email}
              </a>
            } />
            <Field icon={Phone} label="Telefon" value={inquiry.phone} />
            <Field icon={Globe} label="Strona" value={inquiry.website ? (
              <a href={inquiry.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-teal hover:underline">
                {inquiry.website} <ExternalLink size={12} />
              </a>
            ) : null} />
          </dl>
        </section>

        {/* Inquiry details */}
        <section className="mb-6">
          <p className="mb-3 text-xs font-medium text-text-muted uppercase tracking-wide">Zapytanie</p>
          <dl className="space-y-3">
            <Field icon={Tag} label="Typ firmy" value={inquiry.company_type} />
            <Field icon={Tag} label="Przychody" value={inquiry.revenue_bucket} />
            <Field icon={Tag} label="Zainteresowania" value={inquiry.interests?.join(', ')} />
            <Field icon={StickyNote} label="Notatki" value={inquiry.notes} />
          </dl>
        </section>

        {/* Pipedrive */}
        <section className="mb-6">
          <p className="mb-3 text-xs font-medium text-text-muted uppercase tracking-wide">Pipedrive</p>
          {pipedriveUrl ? (
            <a
              href={pipedriveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-lg border border-teal/30 px-3 py-2 text-sm text-teal hover:bg-teal/5 transition-colors"
            >
              <ExternalLink size={14} />
              Otwórz deal #{inquiry.pipedrive_deal_id}
            </a>
          ) : (
            <div className="rounded-lg border border-warm-sand px-3 py-2">
              <p className="text-xs text-text-muted">Brak synchronizacji</p>
              <button
                onClick={() => toast.info('Pipedrive sync: kolejny sprint')}
                className="mt-2 rounded-lg border border-offwhite/15 px-3 py-1.5 text-xs text-text-muted hover:bg-offwhite transition-colors"
              >
                Sync manualny (wkrótce)
              </button>
            </div>
          )}
        </section>

        {/* Meta */}
        <section>
          <p className="mb-3 text-xs font-medium text-text-muted uppercase tracking-wide">Meta</p>
          <dl className="space-y-3">
            <Field icon={Calendar} label="Data" value={new Date(inquiry.created_at).toLocaleString('pl-PL')} />
            <Field icon={Hash} label="IP hash" value={inquiry.ip_hash} />
          </dl>
        </section>
      </SheetContent>
    </Sheet>
  );
}
