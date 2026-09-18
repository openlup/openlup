import { Fragment } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { statusColors } from './emailLabels';
import type { EmailSendWithTester } from './types';

interface EmailSendsTableProps {
  sends: EmailSendWithTester[];
  isLoading: boolean;
  statusMessage?: string | null;
  expandedId: string | null;
  eventsSummary: Record<string, string[]>;
  onToggleExpanded: (id: string) => void;
}

export function EmailSendsTable({
  sends,
  isLoading,
  statusMessage,
  expandedId,
  eventsSummary,
  onToggleExpanded,
}: EmailSendsTableProps) {
  return (
    <div className="-mx-4 overflow-x-auto border border-warm-sand md:mx-0 md:rounded-xl md:overflow-hidden">
      <Table className="min-w-[760px] md:min-w-0">
        <TableHeader>
          <TableRow className="border-warm-sand hover:bg-transparent">
            <TableHead className="text-text-muted">Odbiorca</TableHead>
            <TableHead className="text-text-muted">Szablon</TableHead>
            <TableHead className="text-text-muted">Status</TableHead>
            <TableHead className="text-text-muted">Wysłano</TableHead>
            <TableHead className="text-text-muted">Zdarzenia</TableHead>
            <TableHead className="text-text-muted w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {statusMessage ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-text-muted py-12">
                {statusMessage}
              </TableCell>
            </TableRow>
          ) : isLoading ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-text-muted py-12">
                Ładowanie...
              </TableCell>
            </TableRow>
          ) : sends.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-text-muted py-12">
                Nie znaleziono wysyłek
              </TableCell>
            </TableRow>
          ) : (
            sends.map((send) => {
              const isExpanded = expandedId === send.id;
              const events = eventsSummary[send.id] ?? [];
              const testerName = send.testers
                ? [send.testers.first_name, send.testers.last_name].join(' ')
                : send.recipient_label ?? 'Klient commerce';
              const sentAtLabel = send.sent_at
                ? new Date(send.sent_at).toLocaleDateString('pl-PL', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
                : 'Nie wysłano';

              return (
                <Fragment key={send.id}>
                <TableRow
                  className="border-offwhite/6 cursor-pointer hover:bg-white align-top"
                  onClick={() => onToggleExpanded(send.id)}
                >
                  <TableCell>
                    <div>
                      <span className="font-medium text-teal-dark">{testerName}</span>
                      <p className="text-xs text-text-muted mt-0.5">
                        {send.testers?.email ?? send.delivery_order_number ?? send.delivery_aggregate_id ?? '-'}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="text-text-muted text-sm">{send.template_slug ?? '-'}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={`text-xs capitalize ${statusColors[send.status ?? ''] ?? 'bg-warm-sand text-text-muted border-offwhite/20'}`}
                    >
                      {send.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-text-muted text-sm">{sentAtLabel}</TableCell>
                  <TableCell>
                    <div className="flex gap-1.5 flex-wrap">
                      {events.includes('open') && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-warm-amber/15 px-2 py-0.5 text-[10px] font-medium text-warm-amber">
                          otwarto
                        </span>
                      )}
                      {events.includes('click') && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-soft-lavender/15 px-2 py-0.5 text-[10px] font-medium text-soft-lavender">
                          kliknięto
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-text-muted">
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </TableCell>
                </TableRow>
                {isExpanded ? (
                  <TableRow key={`${send.id}-debug`} className="border-offwhite/6 bg-offwhite/50">
                    <TableCell colSpan={6} className="px-5 py-4">
                      <dl className="grid gap-2 text-xs text-text-muted md:grid-cols-2">
                        <DebugItem label="Delivery status" value={send.delivery_status} />
                        <DebugItem label="Last error" value={send.delivery_last_error_code ?? send.provider_error} />
                        <DebugItem label="Outbox event" value={send.delivery_outbox_event_id} />
                        <DebugItem label="Aggregate" value={send.delivery_aggregate_id} />
                        <DebugItem label="Resend ID" value={send.resend_id} />
                        <DebugItem label="Source" value={send.source} />
                      </dl>
                    </TableCell>
                  </TableRow>
                ) : null}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function DebugItem({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="font-semibold text-teal-dark">{label}</dt>
      <dd className="truncate">{value || '-'}</dd>
    </div>
  );
}
