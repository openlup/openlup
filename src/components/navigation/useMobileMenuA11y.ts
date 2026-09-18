import { useEffect, type RefObject } from "react";

interface UseMobileMenuA11yOptions {
  open: boolean;
  openerRef: RefObject<HTMLElement>;
  panelRef: RefObject<HTMLElement>;
  initialFocusRef: RefObject<HTMLElement>;
  onClose: () => void;
}

export function useMobileMenuA11y({
  open,
  openerRef,
  panelRef,
  initialFocusRef,
  onClose,
}: UseMobileMenuA11yOptions) {
  useEffect(() => {
    if (!open) return undefined;

    const opener = openerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      initialFocusRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [initialFocusRef, open, openerRef]);

  useEffect(() => {
    if (!open) return undefined;

    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "textarea:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((el) => !el.hasAttribute("disabled"));

      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, panelRef]);
}
