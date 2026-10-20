import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PickupPoint } from "@openlup/platform/shipping/contracts";
import { PickupPointPicker } from "./PickupPointPicker";
const { searchPickupPoints } = vi.hoisted(() => ({ searchPickupPoints: vi.fn() }));
vi.mock("@/domains/shipping/deliverySelectionClient", () => ({ searchPickupPoints }));
afterEach(() => { cleanup(); searchPickupPoints.mockReset(); });
it("retries a failed seeded search, picks canonical evidence, restores focus and cancels stale results on clear", async () => {
  const point = { id: "POINT", carrierKind: "carrier-a", name: "Point", address: { line1: "Street 1", postalCode: "CODE", city: "City", country: "ZZ" }, appAssisted: true };
  searchPickupPoints.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ points: [point] });
  const onSelect = vi.fn();
  function Picker() {
    const [selected, setSelected] = useState<PickupPoint | null>(null);
    return <PickupPointPicker carrierKind="carrier-a" city="City" selected={selected} onSelect={(next) => { onSelect(next); setSelected(next); }} />;
  }
  render(<Picker />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Spróbuj ponownie" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Spróbuj ponownie" }));
  fireEvent.click(await screen.findByRole("button", { name: /Point, Street 1/ }));
  expect(onSelect).toHaveBeenCalledWith({ id: point.id, provider: point.carrierKind, name: point.name, address: point.address });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Zmień punkt" }));
  fireEvent.click(screen.getByRole("button", { name: "Zmień punkt" }));
  let settle!: (value: unknown) => void;
  searchPickupPoints.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
  fireEvent.change(screen.getByLabelText("Szukaj punktu"), { target: { value: "Other" } });
  await waitFor(() => expect(searchPickupPoints).toHaveBeenCalledTimes(3));
  fireEvent.change(screen.getByLabelText("Szukaj punktu"), { target: { value: "" } });
  await waitFor(() => expect(screen.queryByRole("button", { name: /Point, Street 1/ })).toBeNull());
  await act(async () => { settle({ points: [point] }); });
  await waitFor(() => expect(screen.queryByRole("button", { name: /Point, Street 1/ })).toBeNull());
});
