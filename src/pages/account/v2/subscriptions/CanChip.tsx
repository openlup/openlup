import { cn } from "@/lib/utils";

/**
 * A single product tile in the package preview: can image in a tinted square
 * with an ×N (recipe) or +N (add-on) quantity badge, label below.
 * See design handoff §3 (PackageCard) — `subskrypcja-pakiet.png`.
 */
export function CanChip({
  image,
  label,
  qty,
  color,
  addon = false,
}: {
  image: string | null;
  label: string;
  qty: number;
  /** Accent hex for the flavour tint (recipe chips only). */
  color?: string;
  addon?: boolean;
}) {
  return (
    <div className="flex w-[88px] shrink-0 flex-col items-center gap-2">
      <div
        className={cn(
          "relative flex h-[88px] w-[88px] items-center justify-center rounded-card",
          addon
            ? "border border-dashed border-copper/50 bg-copper/5"
            : "border border-teal-dark/8",
        )}
        style={
          !addon && color
            ? { backgroundColor: `color-mix(in srgb, ${color} 12%, white)` }
            : undefined
        }
      >
        {image ? (
          <img src={image} alt="" className="h-[72px] w-auto object-contain" />
        ) : (
          <span className="font-display text-lg font-bold text-teal-dark/40">
            {label.charAt(0)}
          </span>
        )}
        <span
          className={cn(
            "absolute -right-1.5 -top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-bold text-white",
            addon ? "bg-copper" : "bg-teal-dark",
          )}
        >
          {addon ? `+${qty}` : `×${qty}`}
        </span>
      </div>
      <span
        className={cn(
          "text-center text-xs-plus font-semibold",
          addon ? "text-copper" : "text-foreground",
        )}
      >
        {label}
      </span>
    </div>
  );
}
