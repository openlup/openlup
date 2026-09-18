// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
const defaultLanguage = "xx";
const copy = { recoveryGuidance: { messages: { c07: "fixture recovery message" }, actions: { chooseCard: "fixture alternative" } } };
import { CheckoutRecoveryNotice } from "./CheckoutRecoveryNotice";
import type { CheckoutRecoveryPresentation } from "../machine/checkoutRecoveryGuidance";
const { report } = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/telemetry/checkoutClientEvent", () => ({ reportCheckoutClientEvent: report }));
const presentation: CheckoutRecoveryPresentation = {
  messageKey: "checkout:recoveryGuidance.messages.c07", emphasis: "recommended",
  actions: [{ kind: "change_method", labelKey: "checkout:recoveryGuidance.actions.chooseCard", method: "card" }],
};
async function mount(language = defaultLanguage, disabled = false) {
  const i18n = createInstance();
  await i18n.init({ lng: language, fallbackLng: defaultLanguage, resources: { [defaultLanguage]: { checkout: copy }, yy: { checkout: {} } } });
  const onAction = vi.fn(); const onSubmit = vi.fn((event) => event.preventDefault());
  render(<I18nextProvider i18n={i18n}><form onSubmit={onSubmit}>
    <CheckoutRecoveryNotice presentation={presentation} onAction={onAction} disabled={disabled} />
  </form></I18nextProvider>);
  return { onAction, onSubmit };
}
afterEach(() => { cleanup(); report.mockReset(); });
describe("checkout recovery notice", () => {
  it("announces approved copy once and selects a method without form submission", async () => {
    const { onAction, onSubmit } = await mount();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText(copy.recoveryGuidance.messages.c07)).toBeTruthy();
    const button = screen.getByRole("button", { name: "fixture alternative" });
    button.focus(); expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith(presentation.actions[0]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(report.mock.calls).toEqual([["payment_form", "recommendation_shown"], ["payment_form", "recommendation_selected"]]);
  });
  it("renders no raw keys or unapproved fallback language when translations are absent", async () => {
    await mount("yy");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });
  it("keeps selection disabled during an active operation", async () => {
    const { onAction } = await mount(undefined, true);
    fireEvent.click(screen.getByRole("button"));
    expect(onAction).not.toHaveBeenCalled();
  });

});
