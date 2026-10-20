import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DeliveryOption } from "@openlup/platform/shipping/contracts";
import { DeliveryMethodCard } from "./DeliveryMethodCard";
import { ShippingFieldsCard } from "./ShippingFieldsCard";
afterEach(cleanup);
it("selects exact dictionary evidence, hides manual selection during loading and permits manual address fallback", () => {
  const option: DeliveryOption = { id: "route", kind: "courier", deliveryKind: "courier", providerKind: "provider-a",
    carrierKind: "carrier-a", carrierCode: "CODE", service: "standard", serviceCode: "SERVICE", label: "Route", description: "Delivery", pickupPointRequired: false, addressRequired: true };
  const select = vi.fn(); const change = vi.fn(); const update = vi.fn();
  const { rerender } = render(<DeliveryMethodCard deliverySelectionEnabled options={[option]} onSelectOption={select} />);
  fireEvent.click(screen.getByRole("radio", { name: /Route/ }));
  expect(select).toHaveBeenCalledWith(option);
  rerender(<DeliveryMethodCard loadingOptions onChange={change} />);
  expect(screen.queryByRole("radio")).toBeNull();
  rerender(<DeliveryMethodCard options={[]} deliverySelectionEnabled value="courier" onChange={change} />);
  fireEvent.click(screen.getByRole("radio", { name: "Punkt odbioru" }));
  expect(change).toHaveBeenCalledWith("parcel-locker");
  rerender(<ShippingFieldsCard data={{ street: "Street 1", postalCode: "CODE", city: "City", country: "ZZ", phone: "contact" }}
    errors={{ street: "Required" }} update={update} />);
  fireEvent.change(screen.getByLabelText("Miejscowość"), { target: { value: "New city" } });
  expect(update).toHaveBeenCalledWith({ city: "New city" });
  expect(screen.getByRole("alert").textContent).toBe("Required");
});
