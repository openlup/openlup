import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AdminPanel } from "@/components/admin/AdminSurface";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// One shell for every titled section of the order detail sheet.
//
// The `<section class="rounded-lg border border-warm-sand bg-white p-4">` +
// `<h3 class="mb-3 font-semibold text-teal-dark">` pair used to be copied into eight
// files, and four copies had already drifted apart (heading size, missing margin,
// a shadcn border instead of the warm one). One header shape now serves the plain
// sections, the ones that carry a status pill, and the ones that carry an icon.
//
// `variant="plain"` is for a section whose CONTENT is already a grid of cards
// (accounting, channel source): it keeps the shared heading without nesting a card
// inside a card.
//
// The two overrides on AdminPanel pin the sheet's CURRENT radius and elevation.
// AdminPanel's own `rounded-card`/`shadow-sm` would restyle every panel in the sheet
// at once, which is a look no wave owns; dropping the two tokens below is the whole
// move to the design-system card when someone does own it.
export function DetailSection({
  testId,
  title,
  subtitle,
  icon: Icon,
  actions,
  variant = "card",
  className,
  children,
}: {
  testId?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  variant?: "card" | "plain";
  className?: string;
  children: ReactNode;
}) {
  const header = (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", variant === "card" && "mb-3")}>
      <div className="flex items-center gap-2">
        {Icon ? <Icon className="text-teal" size={18} aria-hidden="true" /> : null}
        <div>
          <h3 className="font-semibold text-teal-dark">{title}</h3>
          {subtitle ? <p className="text-sm text-text-muted">{subtitle}</p> : null}
        </div>
      </div>
      {actions ?? null}
    </div>
  );

  if (variant === "plain") {
    return (
      <section data-testid={testId} className={cn("space-y-3", className)}>
        {header}
        {children}
      </section>
    );
  }

  return (
    <AdminPanel testId={testId} className={cn("rounded-lg p-4 shadow-none", className)}>
      {header}
      {children}
    </AdminPanel>
  );
}

export function InfoBlock({ label, value, meta, children }: { label: string; value: string; meta: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-warm-sand bg-white p-4">
      <p className="label-text mb-1 text-text-muted">{label}</p>
      <p className="break-words font-medium text-teal-dark">{value}</p>
      {meta && <p className="mt-1 break-words text-xs text-text-muted">{meta}</p>}
      {children}
    </div>
  );
}

export function ActionButton({
  icon: Icon,
  label,
  hint,
  disabled,
  disabledReason,
  confirm,
  testId,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  // Plain-language "what it does" copy. On enabled buttons it rides the native `title`
  // (which works on hover); on disabled buttons the reason takes over (see below).
  hint?: string | null;
  disabled: boolean;
  disabledReason?: string | null;
  confirm?: {
    title: string;
    description: string;
    actionLabel: string;
    cancelLabel: string;
  };
  testId?: string;
  onClick: () => void;
}) {
  const reasonTitle = disabled && disabledReason ? `${label}: ${disabledReason}` : null;
  // Native `title` fires on hover for ENABLED buttons, so the hint is discoverable there.
  const buttonTitle = reasonTitle ?? (hint ? `${label}: ${hint}` : label);
  const button = (
    <Button
      type="button"
      size="sm"
      data-testid={testId}
      disabled={disabled}
      onClick={confirm ? undefined : onClick}
      aria-label={reasonTitle ?? label}
      title={buttonTitle}
      className="gap-2 bg-teal text-void hover:bg-teal/90 disabled:bg-warm-sand disabled:text-text-muted"
    >
      <Icon size={15} aria-hidden="true" />
      {label}
    </Button>
  );
  // A disabled <button> emits no pointer events, so its native `title` tooltip never
  // fires and the operator sees a greyed button with no reason. Wrap the trigger in a
  // focusable span + Radix Tooltip so the already-computed reason is visible on hover
  // AND keyboard focus. Enabled buttons keep the native-title path above; the confirm
  // dialog is skipped here because a disabled trigger cannot open it anyway. Self-
  // contained TooltipProvider works with or without an ancestor (incl. under tests).
  if (disabled && disabledReason) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" tabIndex={0} data-testid={testId ? `${testId}-reason-trigger` : undefined}>
              {button}
            </span>
          </TooltipTrigger>
          <TooltipContent
            role="tooltip"
            className="z-tooltip max-w-xs border-warm-sand bg-white text-teal-dark"
            data-testid={testId ? `${testId}-reason` : undefined}
          >
            {disabledReason}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  if (!confirm) return button;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{button}</AlertDialogTrigger>
      <AlertDialogContent data-testid="admin-oms-confirm-dialog" className="border-warm-sand bg-white text-teal-dark">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-teal-dark">{confirm.title}</AlertDialogTitle>
          <AlertDialogDescription className="text-text-muted">{confirm.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="admin-oms-confirm-cancel" className="border-warm-sand bg-offwhite text-teal-dark hover:bg-warm-sand">
            {confirm.cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="admin-oms-confirm-action"
            disabled={disabled}
            className="bg-teal text-void hover:bg-teal/90 disabled:bg-warm-sand disabled:text-text-muted"
            onClick={disabled ? undefined : onClick}
          >
            {confirm.actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
