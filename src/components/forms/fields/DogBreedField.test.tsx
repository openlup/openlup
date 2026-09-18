import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DogBreedCombobox } from "./DogBreedField";

describe("DogBreedCombobox", () => {
  it("shows popular breeds on focus without rendering the full catalog", () => {
    render(<DogBreedDemo />);

    fireEvent.focus(screen.getByLabelText("Rasa psa"));

    expect(screen.getAllByRole("option")).toHaveLength(22);
    expect(screen.getByRole("option", { name: "Border collie" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Aidi" })).not.toBeInTheDocument();
  });

  it("filters, limits, and selects suggestions with the keyboard", () => {
    render(<DogBreedDemo />);
    const input = screen.getByLabelText("Rasa psa");

    fireEvent.change(input, { target: { value: "labrador" } });
    expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(12);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input).toHaveValue("Labrador retriever");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps custom values when the user does not pick a suggestion", () => {
    render(<DogBreedDemo />);
    const input = screen.getByLabelText("Rasa psa");

    fireEvent.change(input, { target: { value: "Kosmiczny pies" } });
    fireEvent.blur(input);

    expect(input).toHaveValue("Kosmiczny pies");
  });
});

function DogBreedDemo() {
  const [value, setValue] = useState("");

  return (
    <label>
      Rasa psa
      <DogBreedCombobox
        id="dog-breed-demo"
        value={value}
        onValueChange={setValue}
        inputClassName="border"
      />
    </label>
  );
}
