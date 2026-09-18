/**
 * Stacked proportion bar for the recipe mix + legend. Widths are the share of
 * each recipe's can count in the total (real `lines[].qty`), colours are the
 * brand flavour accents. See design handoff §3 (FlavourMixBar).
 */

export interface MixSegment {
  label: string;
  qty: number;
  color: string;
}

export function FlavourMixBar({ segments }: { segments: MixSegment[] }) {
  const total = segments.reduce((sum, segment) => sum + segment.qty, 0) || 1;

  return (
    <div className="space-y-3">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-teal-dark/5">
        {segments.map((segment) => (
          <span
            key={segment.label}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${(segment.qty / total) * 100}%`,
              backgroundColor: segment.color,
            }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center gap-1.5 text-xs-plus">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: segment.color }}
            />
            <span className="text-foreground/70">{segment.label}</span>
            <span className="font-bold text-foreground">×{segment.qty}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
