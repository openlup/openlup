import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Cream modal shell for the account redesign. Radix portals to <body> — outside
 * the `.account-light` wrapper — so the scope class is re-applied here, giving
 * the modal the cream/white tokens. Used by all manage modals.
 */
export function ManageDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "account-light grid max-h-[88vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-[24px] border-teal-dark/8 bg-card p-0 text-foreground shadow-lg sm:max-w-lg",
          className,
        )}
      >
        <DialogHeader className="space-y-1 px-6 pt-6 text-left">
          <DialogTitle className="font-display text-2xl font-bold text-foreground">
            {title}
          </DialogTitle>
          {description ? (
            <DialogDescription className="text-sm text-foreground/60">
              {description}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 max-h-[60vh] overflow-y-auto px-6 py-5">{children}</div>

        {footer ? (
          <div className="flex items-center justify-end gap-3 border-t border-teal-dark/8 bg-offwhite/40 px-6 py-4">
            {footer}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
