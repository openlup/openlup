import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { buildEmailSupportReport } from '@/domains/communications/emailSupportReport';
import { eventTypeColor, eventTypeLabel } from './emailLabels';
import type { EmailEvent, EmailSendWithTester } from './types';

interface EmailSendDetailPanelProps {
  send: EmailSendWithTester | null;
  events: EmailEvent[];
}

export function EmailSendDetailPanel({ send, events }: EmailSendDetailPanelProps) {
  if (!send) return null;

  const supportReport = buildEmailSupportReport(send, events);

  return (
    <div className="mt-2 rounded-xl border border-warm-sand bg-offwhite/2 p-5">
      <h3 className="mb-4 text-sm font-semibold text-teal-dark">Raport supportowy</h3>
      <div className="mb-6 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <SupportField label="Odbiorca" value={supportReport.recipientReference} />
        <SupportField label="Wysłano" value={supportReport.sentAt} />
        <SupportField
          label="Provider outcome"
          value={supportReport.providerOutcome}
          danger={Boolean(send.provider_error)}
        />
        <SupportField label="Trigger source" value={supportReport.triggerSource} />
        <SupportField label="Trigger reason" value={supportReport.triggerReason} />
        <SupportField label="Środowisko" value={supportReport.environment} />
        <SupportField label="Resolved base URL" value={supportReport.resolvedBaseUrl} />
        <SupportField label="Origin source" value={supportReport.originSource} />
        <SupportField label="Provider message ID" value={supportReport.providerMessageId} />
        <SupportField label="Send attempt ID" value={supportReport.sendAttemptId} />
        <SupportField
          label="Audit"
          value={supportReport.auditCompleteness}
          danger={supportReport.auditCompleteness === 'audit_incomplete'}
        />
        <SupportField
          label="Braki dowodów"
          value={supportReport.missingEvidence.length > 0 ? supportReport.missingEvidence.join(', ') : '-'}
          danger={supportReport.missingEvidence.length > 0}
        />
        <SupportField label="Outbox event ID" value={supportReport.outboxEventId} />
        <SupportField label="Job run ID" value={supportReport.platformJobRunId} />
        <SupportField label="Referencje" value={supportReport.aggregateReference} />
        <SupportField label="Ostatnie zdarzenie" value={supportReport.latestEvent} />
      </div>

      <h3 className="mb-4 text-sm font-semibold text-teal-dark">Historia zdarzeń</h3>
      {events.length === 0 ? (
        <p className="text-sm text-text-muted">Brak zdarzeń dla tej wysyłki.</p>
      ) : (
        <div className="relative ml-3">
          <div className="absolute left-0 top-1 bottom-1 w-px bg-offwhite/12" />
          <div className="space-y-4">
            {events.map((evt) => (
              <div key={evt.id} className="relative pl-6">
                <div
                  className={`absolute left-[-4px] top-1.5 h-2 w-2 rounded-full ${
                    evt.event_type === 'bounce' || evt.event_type === 'complaint'
                      ? 'bg-warm-coral'
                      : evt.event_type === 'open'
                        ? 'bg-warm-amber'
                        : evt.event_type === 'click'
                          ? 'bg-soft-lavender'
                          : 'bg-sage-mint'
                  }`}
                />

                <div className="flex items-start gap-3">
                  <Badge variant="outline" className={`text-[10px] ${eventTypeColor(evt.event_type ?? '')}`}>
                    {eventTypeLabel(evt.event_type ?? '')}
                  </Badge>
                  <span className="text-xs text-text-muted">
                    {new Date(evt.timestamp).toLocaleDateString('pl-PL', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                </div>

                {evt.event_type === 'click' && evt.link_url && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <ExternalLink size={12} className="text-text-muted" />
                    <a
                      href={evt.link_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-teal hover:underline truncate max-w-md"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {evt.link_url}
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SupportField({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-text-muted">{label}</p>
      <p className={`mt-1 break-all ${danger ? 'text-warm-coral' : 'text-teal-dark/75'}`}>{value}</p>
    </div>
  );
}
