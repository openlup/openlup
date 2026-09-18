import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConsentCheckbox } from "./ConsentCheckbox";

describe("ConsentCheckbox", () => {
  it("renders checked and unchecked states through the design-system checkbox", () => {
    const onChange = vi.fn();

    render(
      <ConsentCheckbox
        checked={false}
        label="Akceptuję zgodę"
        onCheckedChange={onChange}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Akceptuję zgodę" });
    expect(checkbox).toHaveAttribute("aria-checked", "false");

    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("links errors to aria-describedby and marks invalid state", () => {
    render(
      <ConsentCheckbox
        checked={false}
        error="Ta zgoda jest wymagana"
        label="Zgoda RODO"
        onCheckedChange={vi.fn()}
        required
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: /Zgoda RODO/ });
    const error = screen.getByText("Ta zgoda jest wymagana");
    expect(checkbox).toHaveAttribute("aria-invalid", "true");
    expect(checkbox.getAttribute("aria-describedby")).toContain(error.id);
    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it("supports disabled rich labels without breaking links", () => {
    render(
      <ConsentCheckbox
        checked
        disabled
        label={
          <>
            Zgadzam się z <a href="/regulamin">regulaminem</a>
          </>
        }
        onCheckedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /Zgadzam się z regulaminem/ })).toBeDisabled();
    expect(screen.getByRole("link", { name: "regulaminem" })).toHaveAttribute("href", "/regulamin");
  });
});
