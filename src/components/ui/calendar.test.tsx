import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Calendar } from "./calendar";

describe("Calendar", () => {
  const july = new Date(2026, 6, 1);

  it("renders and navigates with the react-day-picker v9 component contract", () => {
    render(<Calendar defaultMonth={july} />);

    expect(screen.getByRole("grid", { name: "July 2026" })).toBeInTheDocument();

    const previous = screen.getByRole("button", { name: "Go to the Previous Month" });
    const next = screen.getByRole("button", { name: "Go to the Next Month" });
    expect(previous.querySelector("svg")).toBeInTheDocument();
    expect(next.querySelector("svg")).toBeInTheDocument();

    fireEvent.click(next);

    expect(screen.getByRole("grid", { name: "August 2026" })).toBeInTheDocument();
  });

  it("keeps selection behavior and caller overrides intact", () => {
    const onSelect = vi.fn();

    render(
      <Calendar
        classNames={{ selected: "caller-selected" }}
        defaultMonth={july}
        mode="single"
        onSelect={onSelect}
        selected={new Date(2026, 6, 18)}
      />,
    );

    const selectedCell = screen.getByRole("gridcell", { selected: true });
    expect(selectedCell).toHaveClass("caller-selected");

    fireEvent.click(screen.getByRole("button", { name: "Sunday, July 19th, 2026" }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect.mock.calls[0]?.[0]).toEqual(new Date(2026, 6, 19));
  });
});
