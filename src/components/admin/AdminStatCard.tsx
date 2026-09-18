interface AdminStatCardProps {
  label: string;
  value: string;
  suffix?: string;
}

export function AdminStatCard({ label, value, suffix }: AdminStatCardProps) {
  return (
    <div className="rounded-xl border border-warm-sand bg-offwhite/2 p-4">
      <p className="label-text text-text-muted mb-1">{label}</p>
      <p className="font-display text-2xl font-semibold">
        {value}{" "}
        {suffix && <span className="text-base text-text-muted font-normal">{suffix}</span>}
      </p>
    </div>
  );
}
