import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const profiles = {
  instagram: "https://www.instagram.com/example/",
  facebook: "https://www.facebook.com/example/",
};

async function renderLinks(variant: "nav" | "footer", links: Partial<typeof profiles> = profiles) {
  vi.doMock("@/lib/brand/appBrand", () => ({ APP_SOCIAL_LINKS: links }));
  const { SocialLinks } = await import("@/components/SocialLinks");
  return render(<SocialLinks variant={variant} />);
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SocialLinks", () => {
  beforeEach(() => vi.resetModules());

  it("nav variant renders one labelled icon link per profile, opening in a new tab", async () => {
    await renderLinks("nav");
    const group = screen.getByRole("group", { name: "common:social.label" });
    expect(group).toBeInTheDocument();
    const instagram = screen.getByRole("link", { name: "common:social.instagram" });
    const facebook = screen.getByRole("link", { name: "common:social.facebook" });
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(instagram).toHaveAttribute("href", profiles.instagram);
    expect(facebook).toHaveAttribute("href", profiles.facebook);
    for (const link of [instagram, facebook]) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("footer variant shows the network names next to the icons", async () => {
    await renderLinks("footer");
    expect(screen.getByRole("link", { name: "common:social.instagram" })).toHaveTextContent("Instagram");
    expect(screen.getByRole("link", { name: "common:social.facebook" })).toHaveTextContent("Facebook");
  });

  it("points at the configured https profiles on the two networks", async () => {
    await renderLinks("nav");
    const instagram = new URL(screen.getByRole("link", { name: "common:social.instagram" }).getAttribute("href")!);
    const facebook = new URL(screen.getByRole("link", { name: "common:social.facebook" }).getAttribute("href")!);
    expect(instagram).toMatchObject({ protocol: "https:", hostname: "www.instagram.com" });
    expect(facebook).toMatchObject({ protocol: "https:", hostname: "www.facebook.com" });
    expect(instagram.pathname.length).toBeGreaterThan(1);
    expect(facebook.pathname.length).toBeGreaterThan(1);
  });

  it.each(["nav", "footer"] as const)("%s renders nothing when no profile is configured", async (variant) => {
    const { container } = await renderLinks(variant, {});
    expect(container).toBeEmptyDOMElement();
  });
});
