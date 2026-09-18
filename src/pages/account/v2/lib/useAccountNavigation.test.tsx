import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import { useAccountNavigation } from "./useAccountNavigation";

const account = {
  pets: [],
  subscriptions: [
    { subscriptionId: "s1", petId: "p1", status: "active" },
    { subscriptionId: "s2", petId: "p2", status: "active" },
  ],
} as unknown as CustomerAccountV2Response;

function harness(initialEntries: string[] = ["/konto"]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
  );
  return renderHook(
    () => ({ nav: useAccountNavigation(account), search: useLocation().search }),
    { wrapper },
  );
}

describe("useAccountNavigation", () => {
  it("defaults to start + first subscription when no params", () => {
    const { result } = harness();
    expect(result.current.nav.tab).toBe("start");
    expect(result.current.nav.selectedSubId).toBe("s1");
    expect(result.current.nav.modal).toBeNull();
    expect(result.current.nav.profileOpen).toBe(false);
    expect(result.current.search).toBe("");
  });

  it("hydrates section / subscription / modal from the URL", () => {
    const { result } = harness(["/konto?sekcja=subscriptions&sub=s2&modal=reschedule"]);
    expect(result.current.nav.tab).toBe("subscriptions");
    expect(result.current.nav.selectedSubId).toBe("s2");
    expect(result.current.nav.modal).toBe("reschedule");
  });

  it("maps the change-address modal to the `adres` slug both ways", () => {
    const { result } = harness(["/konto?modal=adres"]);
    expect(result.current.nav.modal).toBe("changeAddress");
    act(() => result.current.nav.setModal("changeAddress"));
    expect(result.current.search).toContain("modal=adres");
  });

  it("writes section to ?sekcja and omits it for the default start", () => {
    const { result } = harness();
    act(() => result.current.nav.setTab("pets"));
    expect(result.current.search).toContain("sekcja=pets");
    act(() => result.current.nav.setTab("start"));
    expect(result.current.search).not.toContain("sekcja");
  });

  it("supports the communication section as a first-class deep link", () => {
    const { result } = harness(["/konto?sekcja=communication"]);
    expect(result.current.nav.tab).toBe("communication");
    act(() => result.current.nav.setTab("communication"));
    expect(result.current.search).toContain("sekcja=communication");
  });

  it("selects a subscription via ?sub", () => {
    const { result } = harness();
    act(() => result.current.nav.setSelectedSubId("s2"));
    expect(result.current.search).toContain("sub=s2");
    expect(result.current.nav.selectedSubId).toBe("s2");
  });

  it("opens and closes modals + the profile dialog via ?modal", () => {
    const { result } = harness();
    act(() => result.current.nav.setModal("edit"));
    expect(result.current.search).toContain("modal=edit");
    act(() => result.current.nav.setModal(null));
    expect(result.current.search).not.toContain("modal");

    act(() => result.current.nav.setProfileOpen(true));
    expect(result.current.search).toContain("modal=profil");
    expect(result.current.nav.profileOpen).toBe(true);
    expect(result.current.nav.modal).toBeNull();
    act(() => result.current.nav.setProfileOpen(false));
    expect(result.current.search).not.toContain("modal");
  });

  it("steers to a subscription + modal in one combined step (guard CTA)", () => {
    const { result } = harness();
    act(() => result.current.nav.goToSubscription("s2", "reschedule"));
    expect(result.current.search).toContain("sekcja=subscriptions");
    expect(result.current.search).toContain("sub=s2");
    expect(result.current.search).toContain("modal=reschedule");
    expect(result.current.nav.tab).toBe("subscriptions");
    expect(result.current.nav.selectedSubId).toBe("s2");
    expect(result.current.nav.modal).toBe("reschedule");
  });

  it("closes an open modal when navigating to another section", () => {
    const { result } = harness(["/konto?sekcja=subscriptions&sub=s2&modal=edit"]);
    expect(result.current.nav.modal).toBe("edit");
    act(() => result.current.nav.setTab("orders"));
    expect(result.current.nav.modal).toBeNull();
    expect(result.current.search).not.toContain("modal");
  });

  it("normalizes invalid params off the URL, falling back to safe defaults", () => {
    const { result } = harness(["/konto?sekcja=bogus&sub=nope&modal=zzz"]);
    expect(result.current.nav.tab).toBe("start");
    expect(result.current.nav.selectedSubId).toBe("s1");
    expect(result.current.nav.modal).toBeNull();
    // The normalization effect strips the junk params from the URL bar.
    expect(result.current.search).not.toContain("sekcja");
    expect(result.current.search).not.toContain("sub");
    expect(result.current.search).not.toContain("modal");
  });
});
