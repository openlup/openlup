import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useLocation } from "react-router-dom";
import Navigation from "@/components/Navigation";
import { APP_SOCIAL_LINKS } from "@/lib/brand/appBrand";
import { renderWithProviders } from "@/test/render";

const mockChangeLanguage = vi.fn();
const mockUseTranslation = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => mockUseTranslation(),
}));

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framerMotionMock");
  return createFramerMotionMock();
});

vi.mock("@/components/FlavorMegaMenu", () => ({
  FLAVORS: [
    {
      id: "lamb",
      routeKey: "productLamb",
      shortNameKey: "common:nav.lambShort",
      packshot: "/lamb.png",
      packshotEn: "/lamb-en.png",
    },
  ],
  default: ({ onItemClick }: { onItemClick?: () => void }) => (
    <div>
      <button onClick={onItemClick}>Flavor menu</button>
    </div>
  ),
}));

const LocationDisplay = () => {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.hash}`}</div>;
};

describe("Navigation", () => {
  beforeEach(() => {
    mockUseTranslation.mockReturnValue({
      t: (key: string) => key,
      i18n: {
        language: "pl",
        changeLanguage: mockChangeLanguage,
      },
    });
    mockChangeLanguage.mockReset();
    localStorage.clear();
    document.body.style.overflow = "";
  });

  it("navigates to localized routes from desktop links", () => {
    renderWithProviders(
      <>
        <LocationDisplay />
        <Navigation />
      </>,
      { route: "/" },
    );

    fireEvent.click(screen.getByRole("link", { name: "common:nav.science" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/jak-to-dziala");
  });

  it("navigates back to the homepage hash section from other pages", () => {
    renderWithProviders(
      <>
        <LocationDisplay />
        <Navigation />
      </>,
      { route: "/jak-to-dziala" },
    );

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const dogLinks = screen.getAllByRole("link", { name: "common:nav.forDogs" });
    fireEvent.click(dogLinks[dogLinks.length - 1]);

    expect(screen.getByTestId("location")).toHaveTextContent("/#products");
  });

  it("scrolls to the top when the logo is clicked on the homepage", () => {
    const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    renderWithProviders(<Navigation />, { route: "/" });

    fireEvent.click(screen.getByRole("link", { name: "openlup™" }));

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });

    scrollToSpy.mockRestore();
  });

  it("switches language, persists the choice, and navigates to the alternate path", () => {
    renderWithProviders(
      <>
        <LocationDisplay />
        <Navigation />
      </>,
      { route: "/" },
    );

    fireEvent.click(screen.getByRole("button", { name: /PL/i }));
    fireEvent.click(screen.getByRole("button", { name: "EN – English" }));

    expect(localStorage.getItem("openlup-lang")).toBe("en");
    expect(mockChangeLanguage).toHaveBeenCalledWith("en");
    expect(screen.getByTestId("location")).toHaveTextContent("/en");
  });

  it("opens the flavor mega menu and closes it after escape", () => {
    renderWithProviders(<Navigation />, { route: "/" });

    fireEvent.click(screen.getByRole("button", { name: "common:nav.forDogs" }));

    expect(screen.getByRole("button", { name: "Flavor menu" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("button", { name: "Flavor menu" })).not.toBeInTheDocument();
  });

  it("traps focus inside the mobile menu and restores focus on escape", async () => {
    renderWithProviders(<Navigation />, { route: "/" });

    const menuButton = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(menuButton);

    const dialog = screen.getByRole("dialog");
    const firstNetwork = APP_SOCIAL_LINKS.instagram ? "instagram" : APP_SOCIAL_LINKS.facebook ? "facebook" : null;
    const firstFocusable = firstNetwork
      ? within(dialog).getByRole("link", { name: `common:social.${firstNetwork}` })
      : within(dialog).getByRole("button", { name: /PL/i });
    const finalCta = within(dialog).getByRole("link", { name: "common:nav.applyProgram" });
    expect(document.body.style.overflow).toBe("hidden");

    finalCta.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(firstFocusable).toHaveFocus();

    firstFocusable.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(finalCta).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe("");
      expect(menuButton).toHaveFocus();
    });
  });
});
