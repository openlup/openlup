import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Package,
  Truck,
  Mail,
  CheckCircle,
  Clock,
  Pause,
  BarChart3,
  ArrowDown,
  Users,
  XCircle,
} from 'lucide-react';
import {
  getAdminPipeline,
} from '@/domains/platform/adminPipelineClient';
import { useAuth } from '@/lib/authContext';

// --- Order & Shipping pipeline stages ---

interface PipelineStage {
  status: string;
  label: string;
  color: string; // Tailwind text color
  borderColor: string; // Tailwind border-l color
  bgColor: string; // Tailwind bg color
}

const ORDER_STAGES: PipelineStage[] = [
  { status: 'pending_review', label: 'Oczekujące', color: 'text-warm-amber', borderColor: 'border-warm-amber', bgColor: 'bg-warm-amber/10' },
  { status: 'approved', label: 'Zaakceptowane', color: 'text-sage-mint', borderColor: 'border-sage-mint', bgColor: 'bg-sage-mint/10' },
  { status: 'packing', label: 'Pakowanie', color: 'text-soft-lavender', borderColor: 'border-soft-lavender', bgColor: 'bg-soft-lavender/10' },
  { status: 'shipped', label: 'Nadane', color: 'text-teal', borderColor: 'border-teal', bgColor: 'bg-teal/10' },
  { status: 'in_transit', label: 'W drodze', color: 'text-teal', borderColor: 'border-teal', bgColor: 'bg-teal/10' },
  { status: 'delivered', label: 'Dostarczone', color: 'text-sage-mint', borderColor: 'border-sage-mint', bgColor: 'bg-sage-mint/10' },
  { status: 'completed', label: 'Zakończone', color: 'text-teal', borderColor: 'border-teal', bgColor: 'bg-teal/10' },
];

const REJECTED_STAGE: PipelineStage = {
  status: 'rejected',
  label: 'Odrzucone',
  color: 'text-warm-coral',
  borderColor: 'border-warm-coral',
  bgColor: 'bg-warm-coral/10',
};

// --- Stat card ---

interface StatCardProps {
  title: string;
  value: number | string;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ title, value, icon, color }: StatCardProps) {
  return (
    <Card className="border-warm-sand bg-white">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-text-muted">{title}</CardTitle>
        <div className={color}>{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold text-teal-dark">{value}</div>
      </CardContent>
    </Card>
  );
}

// --- Pipeline stage card ---

function StageCard({
  stage,
  count,
  total,
  showArrow,
}: {
  stage: PipelineStage;
  count: number;
  total: number;
  showArrow?: boolean;
}) {
  const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';

  return (
    <div className="flex flex-col items-center">
      <div
        className={`w-full rounded-xl border-l-4 ${stage.borderColor} ${stage.bgColor} border border-offwhite/6 p-4 transition-colors`}
      >
        <div className="flex items-center justify-between">
          <span className={`text-sm font-semibold ${stage.color}`}>{stage.label}</span>
          <span className="text-xs text-text-muted">{pct}%</span>
        </div>
        <div className="mt-1 text-3xl font-bold text-teal-dark">{count}</div>
      </div>
      {showArrow && (
        <ArrowDown size={18} className="my-1 text-teal-dark/20" />
      )}
    </div>
  );
}

// --- Email step card ---

function EmailStepCard({
  step,
  templateName,
  count,
  total,
}: {
  step: number;
  templateName: string | null;
  count: number;
  total: number;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;

  return (
    <div className="w-full rounded-xl border border-offwhite/6 border-l-4 border-l-teal bg-teal/5 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-teal">
          Krok {step}
          {templateName && (
            <span className="ml-2 text-xs font-normal text-text-muted">
              {templateName}
            </span>
          )}
        </span>
        <span className="text-xs text-text-muted">{count}</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-warm-sand">
        <div
          className="h-full rounded-full bg-teal transition-all"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

// --- Main page ---

export default function PipelinePage() {
  const { session } = useAuth();
  const accessToken = session?.access_token;

  const { data } = useQuery({
    queryKey: ['pipeline', accessToken],
    enabled: Boolean(accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error('Admin session required');
      return getAdminPipeline(accessToken);
    },
  });

  const testers = data?.testers ?? [];
  const templates = data?.templates ?? [];
  const emailSendCount = data?.emailSendCount ?? 0;
  const emailEvents = data?.emailEvents ?? [];

  // --- Compute counts ---

  const total = testers.length;

  // Status counts
  const statusCounts: Record<string, number> = {};
  for (const t of testers) {
    statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
  }

  const cnt = (s: string) => statusCounts[s] ?? 0;

  // Summary stats
  const pendingReview = cnt('pending_review');
  const inShipping = cnt('packing') + cnt('shipped') + cnt('in_transit');
  const delivered = cnt('delivered');

  // Email sequence step distribution
  const stepCounts: Record<number, number> = {};
  let pausedCount = 0;
  for (const t of testers) {
    const sequenceStep = t.email_sequence_step ?? 0;
    stepCounts[sequenceStep] = (stepCounts[sequenceStep] || 0) + 1;
    if (t.email_sequence_paused) pausedCount++;
  }

  const maxStep = Math.max(0, ...Object.keys(stepCounts).map(Number));

  // Template name by sequence_order
  const templateByOrder: Record<number, string> = {};
  for (const tpl of templates) {
    if (tpl.sequence_order != null) {
      templateByOrder[tpl.sequence_order] = tpl.name;
    }
  }

  // Email rates
  const deliveredEvents = emailEvents.filter((e) => e.event_type === 'delivered').length;
  const openedEvents = emailEvents.filter((e) => e.event_type === 'opened').length;
  const clickedEvents = emailEvents.filter((e) => e.event_type === 'clicked').length;

  const deliveryRate = emailSendCount > 0 ? ((deliveredEvents / emailSendCount) * 100).toFixed(1) : '0.0';
  const openRate = deliveredEvents > 0 ? ((openedEvents / deliveredEvents) * 100).toFixed(1) : '0.0';
  const clickRate = openedEvents > 0 ? ((clickedEvents / openedEvents) * 100).toFixed(1) : '0.0';

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="mb-6 flex flex-col items-stretch gap-3 md:mb-8 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight md:text-2xl">Pipeline</h1>
          <p className="mt-1 text-sm text-text-muted">
            Wizualizacja przepływu testerów i emaili
          </p>
        </div>
      </div>

      {/* Summary stat cards */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Łącznie testerów"
          value={total}
          icon={<Users size={18} />}
          color="text-teal"
        />
        <StatCard
          title="Oczekujące na recenzję"
          value={pendingReview}
          icon={<Clock size={18} />}
          color="text-warm-amber"
        />
        <StatCard
          title="W wysyłce"
          value={inShipping}
          icon={<Truck size={18} />}
          color="text-soft-lavender"
        />
        <StatCard
          title="Dostarczone"
          value={delivered}
          icon={<CheckCircle size={18} />}
          color="text-sage-mint"
        />
      </div>

      {/* Two pipeline sections */}
      <div className="grid gap-8 lg:grid-cols-2">
        {/* Section 1: Order & Shipping Pipeline */}
        <div>
          <div className="mb-4 flex items-center gap-2">
            <Package size={18} className="text-teal" />
            <h2 className="font-display text-lg font-semibold text-teal-dark">
              Zamówienia i wysyłka
            </h2>
          </div>

          <div className="rounded-2xl border border-warm-sand bg-white/20 p-5">
            <div className="flex flex-col gap-1">
              {ORDER_STAGES.map((stage, i) => (
                <StageCard
                  key={stage.status}
                  stage={stage}
                  count={cnt(stage.status)}
                  total={total}
                  showArrow={i < ORDER_STAGES.length - 1}
                />
              ))}
            </div>

            {/* Rejected branch */}
            <div className="mt-6 border-t border-offwhite/6 pt-4">
              <div className="mb-2 flex items-center gap-2">
                <XCircle size={14} className="text-warm-coral" />
                <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Odrzucone (osobna ścieżka)
                </span>
              </div>
              <StageCard
                stage={REJECTED_STAGE}
                count={cnt('rejected')}
                total={total}
              />
            </div>
          </div>
        </div>

        {/* Section 2: Email Pipeline */}
        <div>
          <div className="mb-4 flex items-center gap-2">
            <Mail size={18} className="text-teal" />
            <h2 className="font-display text-lg font-semibold text-teal-dark">
              Pipeline emailowy
            </h2>
          </div>

          <div className="rounded-2xl border border-warm-sand bg-white/20 p-5">
            {/* Email rate cards */}
            <div className="mb-6 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-offwhite/6 bg-white p-3">
                <div className="text-xs text-text-muted">Wysłane</div>
                <div className="mt-1 text-xl font-bold text-teal-dark">{emailSendCount}</div>
              </div>
              <div className="rounded-xl border border-offwhite/6 bg-white p-3">
                <div className="text-xs text-text-muted">Dostarczalność</div>
                <div className="mt-1 text-xl font-bold text-teal-dark">{deliveryRate}%</div>
              </div>
              <div className="rounded-xl border border-offwhite/6 bg-white p-3">
                <div className="flex items-center gap-1.5">
                  <BarChart3 size={12} className="text-text-muted" />
                  <div className="text-xs text-text-muted">Otwarcia</div>
                </div>
                <div className="mt-1 text-xl font-bold text-teal-dark">{openRate}%</div>
              </div>
              <div className="rounded-xl border border-offwhite/6 bg-white p-3">
                <div className="flex items-center gap-1.5">
                  <BarChart3 size={12} className="text-text-muted" />
                  <div className="text-xs text-text-muted">Kliknięcia</div>
                </div>
                <div className="mt-1 text-xl font-bold text-teal-dark">{clickRate}%</div>
              </div>
            </div>

            {/* Sequence steps */}
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
              Sekwencja emailowa
            </div>
            <div className="flex flex-col gap-3">
              {Array.from({ length: maxStep + 1 }, (_, i) => i).map((step) => (
                <EmailStepCard
                  key={step}
                  step={step}
                  templateName={templateByOrder[step] ?? null}
                  count={stepCounts[step] ?? 0}
                  total={total}
                />
              ))}

              {maxStep < 0 && (
                <p className="py-4 text-center text-sm text-text-muted">
                  Brak danych o sekwencji emailowej
                </p>
              )}
            </div>

            {/* Paused card */}
            <div className="mt-4 border-t border-offwhite/6 pt-4">
              <div className="flex items-center gap-2 rounded-xl border border-warm-amber/20 bg-warm-amber/5 p-4">
                <Pause size={18} className="text-warm-amber" />
                <div>
                  <div className="text-sm font-semibold text-warm-amber">Wstrzymane</div>
                  <div className="text-xs text-text-muted">
                    Testerzy z wstrzymaną sekwencją
                  </div>
                </div>
                <div className="ml-auto text-2xl font-bold text-warm-amber">{pausedCount}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
