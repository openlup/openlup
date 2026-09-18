export const statusColors: Record<string, string> = {
  sent: 'bg-teal/20 text-teal border-teal/30',
  delivered: 'bg-sage-mint/20 text-sage-mint border-sage-mint/30',
  bounced: 'bg-warm-coral/20 text-warm-coral border-warm-coral/30',
  complained: 'bg-warm-coral/20 text-warm-coral border-warm-coral/30',
};

export function eventTypeLabel(type: string) {
  const labels: Record<string, string> = {
    delivered: 'Dostarczono',
    open: 'Otwarto',
    click: 'Kliknięto',
    bounce: 'Odrzucono',
    complaint: 'Zgłoszono',
    sent: 'Przyjęto przez Resend',
  };
  return labels[type] ?? type;
}

export function eventTypeColor(type: string) {
  const colors: Record<string, string> = {
    delivered: 'bg-sage-mint/20 text-sage-mint border-sage-mint/30',
    open: 'bg-warm-amber/20 text-warm-amber border-warm-amber/30',
    click: 'bg-soft-lavender/20 text-soft-lavender border-soft-lavender/30',
    bounce: 'bg-warm-coral/20 text-warm-coral border-warm-coral/30',
    complaint: 'bg-warm-coral/20 text-warm-coral border-warm-coral/30',
    sent: 'bg-teal/20 text-teal border-teal/30',
  };
  return colors[type] ?? 'bg-offwhite/10 text-offwhite/60 border-offwhite/20';
}
