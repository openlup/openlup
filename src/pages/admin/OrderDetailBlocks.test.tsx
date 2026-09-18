import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PackageCheck } from "lucide-react";

import { ActionButton } from "@/pages/admin/OrderDetailBlocks";
import { renderWithProviders } from "@/test/render";

const REASON = "etykieta jest wymagana przed hand-off";

// renderWithProviders intentionally provides NO TooltipProvider — this also proves the
// self-contained provider inside ActionButton works standalone (and under tests).
describe("ActionButton tooltips", () => {
  it("keeps the disabled reason on native title + aria-label as an accessible fallback", () => {
    renderWithProviders(
      <ActionButton icon={PackageCheck} label="Hand-off" testId="handoff" disabled disabledReason={REASON} onClick={() => {}} />,
    );
    const button = screen.getByTestId("handoff");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", `Hand-off: ${REASON}`);
    expect(button).toHaveAttribute("aria-label", `Hand-off: ${REASON}`);
    const trigger = screen.getByTestId("handoff-reason-trigger");
    expect(trigger).toHaveAttribute("tabindex", "0");
  });

  it("reveals the reason in a tooltip when the disabled trigger is focused", async () => {
    renderWithProviders(
      <ActionButton icon={PackageCheck} label="Hand-off" testId="handoff" disabled disabledReason={REASON} onClick={() => {}} />,
    );
    fireEvent.focus(screen.getByTestId("handoff-reason-trigger"));
    await waitFor(() => {
      expect(screen.getAllByText(REASON).length).toBeGreaterThan(0);
    });
  });

  it("puts the hint on an enabled button's native title (works on hover) without wrapping it", () => {
    const onClick = vi.fn();
    renderWithProviders(
      <ActionButton
        icon={PackageCheck}
        label="Notatka"
        hint="Dodaje notatkę operatora."
        testId="note"
        disabled={false}
        onClick={onClick}
      />,
    );
    expect(screen.queryByTestId("note-reason-trigger")).toBeNull();
    const button = screen.getByTestId("note");
    expect(button).toHaveAttribute("title", "Notatka: Dodaje notatkę operatora.");
    // aria-label stays the plain action label for screen readers on enabled buttons.
    expect(button).toHaveAttribute("aria-label", "Notatka");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not wrap a disabled button that has no reason", () => {
    renderWithProviders(
      <ActionButton icon={PackageCheck} label="Notatka" testId="note" disabled disabledReason={null} onClick={() => {}} />,
    );
    expect(screen.queryByTestId("note-reason-trigger")).toBeNull();
    expect(screen.getByTestId("note")).toBeDisabled();
  });
});
