import { describe, expect, it } from "vitest";
import { mapGeowidgetPointToPickupPoint } from "./inpostGeowidgetPoint";

describe("mapGeowidgetPointToPickupPoint", () => {
  it("maps a Geowidget point onto a strict PickupPoint", () => {
    const point = mapGeowidgetPointToPickupPoint({
      name: "KRA010",
      address: { line1: "Rynek Główny 1" },
      address_details: { city: "Kraków", post_code: "31-042", street: "Rynek Główny", building_number: "1" },
      location: { latitude: 50.06, longitude: 19.93 },
    });
    expect(point).toEqual({
      id: "KRA010",
      provider: "inpost",
      name: "Paczkomat KRA010",
      address: { line1: "Rynek Główny 1", postalCode: "31-042", city: "Kraków", country: "PL" },
    });
  });

  it("builds line1 from street + building number when address.line1 is absent", () => {
    const point = mapGeowidgetPointToPickupPoint({
      name: "WAW999",
      address_details: { city: "Warszawa", post_code: "00-001", street: "Prosta", building_number: "20" },
    });
    expect(point?.address.line1).toBe("Prosta 20");
  });

  it("prefers display_name when present", () => {
    const point = mapGeowidgetPointToPickupPoint({
      name: "GDN001",
      display_name: "InPost Paczkomat GDN001",
      address: { line1: "Długa 5" },
      address_details: { city: "Gdańsk", post_code: "80-001" },
    });
    expect(point?.name).toBe("InPost Paczkomat GDN001");
  });

  it("returns null when required fields are missing or the input is not an object", () => {
    expect(mapGeowidgetPointToPickupPoint({ name: "X" })).toBeNull();
    expect(mapGeowidgetPointToPickupPoint({ address_details: { city: "Kraków", post_code: "31-042" } })).toBeNull();
    expect(mapGeowidgetPointToPickupPoint(null)).toBeNull();
    expect(mapGeowidgetPointToPickupPoint("nope")).toBeNull();
  });
});
