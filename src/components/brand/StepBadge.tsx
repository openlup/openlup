import { cn } from "@/lib/utils";

/**
 * Numbered step heading atom.
 *
 * A teal circle with a step number + adjacent title, used in numbered flows.
 */
interface StepBadgeProps {
  n: number;
  title: string;
  className?: string;
}

export function StepBadge({ n, title, className }: StepBadgeProps) {
  return (
    <div className={cn("flex items-center gap-3 mb-5", className)}>
      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary text-white text-sm font-bold">
        {n}
      </span>
      <h2 className="text-2xl font-bold text-charcoal">{title}</h2>
    </div>
  );
}
