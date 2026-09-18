import { CheckCircle2, Eye, Mail, MousePointerClick } from 'lucide-react';

interface EmailSendsStatsProps {
  stats?: {
    totalSent: number;
    delivered: number;
    opened: number;
    clicked: number;
  };
}

export function EmailSendsStats({ stats }: EmailSendsStatsProps) {
  const statCards = [
    { label: 'Wysłane łącznie', value: stats?.totalSent ?? 0, icon: Mail, color: 'text-teal' },
    { label: 'Dostarczono', value: stats?.delivered ?? 0, icon: CheckCircle2, color: 'text-sage-mint' },
    { label: 'Otwarto', value: stats?.opened ?? 0, icon: Eye, color: 'text-warm-amber' },
    { label: 'Kliknięto', value: stats?.clicked ?? 0, icon: MousePointerClick, color: 'text-soft-lavender' },
  ];

  return (
    <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
      {statCards.map((card) => (
        <div key={card.label} className="rounded-xl border border-warm-sand bg-offwhite/2 p-4">
          <div className="flex items-center gap-3">
            <div className={`rounded-lg bg-offwhite p-2 ${card.color}`}>
              <card.icon size={18} />
            </div>
            <div>
              <p className="text-2xl font-semibold text-teal-dark">{card.value}</p>
              <p className="text-xs text-text-muted">{card.label}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
