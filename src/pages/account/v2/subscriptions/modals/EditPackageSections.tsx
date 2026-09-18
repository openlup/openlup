import type { ReactNode } from "react";
import { Check, Minus, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Presentational sections for {@link EditPackageModal}, split out to keep each
 * file within the 300-LOC architecture guardrail. Pure rendering — all mix/
 * addon mutations are computed in the modal (via subscriptionEditModel) and
 * passed back through callbacks.
 */

/** Segmented single-select section (plan length, portion mode). */
export function SegmentedSection({
  title,
  hint,
  options,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-teal">{title}</h3>
      <p className="mb-2 text-xs text-foreground/55">{hint}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "focus-ring rounded-control border px-4 py-2.5 text-sm font-medium transition-colors motion-reduce:transition-none",
              value === option.value
                ? "border-teal bg-teal/10 text-foreground"
                : "border-teal-dark/10 text-foreground/75 hover:border-teal",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export interface MixRow {
  variantId: string;
  qty: number;
  name: string;
  image: string | null;
  pct: number;
}

export interface AddChip {
  slug: string;
  label: string;
}

export interface MixLabels {
  mix: string;
  mixHint: string;
  mixMinimum: string;
  editorLabel: string;
  distributeEvenly: string;
  /** aria-label builders, interpolated per row with the flavour name and qty. */
  decrease: (row: MixRow) => string;
  increase: (row: MixRow) => string;
  remove: (row: MixRow) => string;
}

export function MixSection({
  rows,
  labels,
  total,
  minTotal,
  lineMax,
  available,
  onDistribute,
  onIncrement,
  onDecrement,
  onRemove,
  onAdd,
}: {
  rows: MixRow[];
  labels: MixLabels;
  /** Current order total across all rows; the MOQ is an order-level rule, not a per-line one. */
  total: number;
  minTotal: number;
  lineMax: number;
  available: AddChip[];
  onDistribute: () => void;
  onIncrement: (variantId: string) => void;
  onDecrement: (variantId: string) => void;
  onRemove: (variantId: string) => void;
  onAdd: (slug: string) => void;
}) {
  // Every "−" costs the order exactly one can (at qty 1 it drops the whole
  // line, which is also -1), so one rule covers both cases.
  const decrementBlocked = total <= minTotal;
  return (
    <section>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-teal">{labels.mix}</h3>
        <button
          type="button"
          onClick={onDistribute}
          className="focus-ring text-xs font-semibold text-teal hover:underline"
        >
          {labels.distributeEvenly}
        </button>
      </div>
      <p className="text-xs text-foreground/55">{labels.mixHint}</p>
      <p className="mb-3 text-xs font-medium text-foreground/70">{labels.mixMinimum}</p>
      <ul className="space-y-2" role="group" aria-label={labels.editorLabel}>
        {rows.map((row) => (
          <li
            key={row.variantId}
            className="flex items-center gap-3 rounded-control border border-teal-dark/8 p-2.5"
          >
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-teal-dark/5">
              {row.image ? <img src={row.image} alt="" className="h-10 w-auto object-contain" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">{row.name}</span>
              <span className="text-xxs text-foreground/55">{row.pct}%</span>
            </span>
            <span className="flex items-center gap-1.5">
              <StepperButton
                onClick={() => onDecrement(row.variantId)}
                label={labels.decrease(row)}
                disabled={decrementBlocked}
              >
                <Minus size={14} />
              </StepperButton>
              <span aria-live="polite" className="w-6 text-center text-sm font-bold text-foreground">
                {row.qty}
              </span>
              <StepperButton
                onClick={() => onIncrement(row.variantId)}
                label={labels.increase(row)}
                disabled={row.qty >= lineMax}
              >
                <Plus size={14} />
              </StepperButton>
              <StepperButton
                onClick={() => onRemove(row.variantId)}
                label={labels.remove(row)}
                disabled={rows.length <= 1 || total - row.qty < minTotal}
              >
                <Trash2 size={14} />
              </StepperButton>
            </span>
          </li>
        ))}
      </ul>
      {available.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {available.map((chip) => (
            <button
              key={chip.slug}
              type="button"
              onClick={() => onAdd(chip.slug)}
              className="focus-ring inline-flex items-center gap-1 rounded-full border border-teal-dark/12 px-3 py-1.5 text-xs font-medium text-foreground/75 hover:border-teal"
            >
              <Plus size={12} />
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function AddonsSection({
  heading,
  items,
  addLabel,
  removeLabel,
  onToggle,
}: {
  heading: string;
  items: Array<{ variantId: string; label: string; active: boolean }>;
  addLabel: string;
  removeLabel: string;
  onToggle: (variantId: string) => void;
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-teal">{heading}</h3>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.variantId}
            className="flex items-center justify-between rounded-control border border-teal-dark/8 px-3 py-2 text-sm"
          >
            <span className="text-foreground/80">{item.label}</span>
            <button
              type="button"
              onClick={() => onToggle(item.variantId)}
              className={cn(
                "focus-ring inline-flex items-center gap-1 rounded-control border px-2.5 py-1 text-xs font-medium transition-colors",
                item.active
                  ? "border-copper/40 text-copper hover:border-copper"
                  : "border-teal-dark/12 text-foreground/75 hover:border-teal",
              )}
            >
              {item.active ? removeLabel : addLabel}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReviewSection({ heading, lines, noChanges }: {
  heading: string;
  lines: string[];
  noChanges: string | null;
}) {
  return (
    <div className="rounded-control border border-teal/20 bg-teal/[0.06] p-4">
      <p className="text-sm font-semibold text-teal-dark">{heading}</p>
      <ul className="mt-3 space-y-2 text-sm text-foreground/80">
        {lines.map((text) => (
          <li key={text} className="flex items-start gap-2">
            <Check size={15} className="mt-0.5 shrink-0 text-teal" />
            <span>{text}</span>
          </li>
        ))}
      </ul>
      {noChanges ? <p className="mt-3 text-xs text-foreground/55">{noChanges}</p> : null}
    </div>
  );
}

export function PriceReview({
  rows,
  notice,
}: {
  rows: Array<{ label: string; value: string; tone?: "neutral" | "positive" | "negative" }>;
  notice: string;
}) {
  return (
    <section className="rounded-control border border-teal-dark/10 bg-card px-4 py-3">
      <dl className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4 text-sm">
            <dt className="text-foreground/60">{row.label}</dt>
            <dd
              className={cn(
                "font-bold text-foreground",
                row.tone === "positive" ? "text-teal-dark" : null,
                row.tone === "negative" ? "text-copper" : null,
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-foreground/55">{notice}</p>
    </section>
  );
}

function StepperButton({
  onClick,
  label,
  disabled,
  children,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
      // 32px visual box; before:-inset-1.5 pseudo extends the pointer/touch target to 44px
      className="focus-ring relative grid h-8 w-8 place-items-center rounded-control border border-teal-dark/12 text-foreground/70 transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:border-teal hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
