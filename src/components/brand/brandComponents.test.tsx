import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/buttonVariants";
import { Icon } from "@/components/brand/Icon";
import { Pill } from "@/components/brand/Pill";
import { StepBadge } from "@/components/brand/StepBadge";

describe("buttonVariants — brand CTA variants", () => {
  it("cta-marketing applies the semantic --cta pill with cta glow", () => {
    const cls = buttonVariants({ variant: "cta-marketing", size: "hero" });
    expect(cls).toContain("bg-cta");
    expect(cls).toContain("text-cta-foreground");
    expect(cls).toContain("rounded-full");
    expect(cls).toContain("shadow-cta");
    expect(cls).toContain("text-base-plus"); // hero size = 17px token
    expect(cls).toContain("hover:scale-[1.03]");
  });

  it("section size uses the 15px token", () => {
    const cls = buttonVariants({ variant: "cta-marketing", size: "section" });
    expect(cls).toContain("text-sm-plus");
    expect(cls).toContain("px-8");
  });

  it("cta-teal and cta-marketing-outline are distinct brand variants", () => {
    expect(buttonVariants({ variant: "cta-teal" })).toContain("bg-teal");
    const outline = buttonVariants({ variant: "cta-marketing-outline" });
    expect(outline).toContain("border-cta");
    expect(outline).toContain("text-cta");
    expect(outline).toContain("hover:text-cta-foreground");
  });
});

describe("Button asChild — renders anchor with CTA classes (twMerge dedup)", () => {
  it("renders an <a> and resolves base text-sm to hero text-base-plus", () => {
    render(
      <Button asChild variant="cta-marketing" size="hero">
        <a href="/free-samples">Zamów próbki</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Zamów próbki" });
    expect(link).toHaveAttribute("href", "/free-samples");
    // twMerge (extended for custom sizes) must drop base text-sm in favor of token
    expect(link.className).toContain("text-base-plus");
    expect(link.className).not.toMatch(/\btext-sm\b/);
    // and rounded-md (base) replaced by rounded-full (variant)
    expect(link.className).toContain("rounded-full");
    expect(link.className).not.toMatch(/\brounded-md\b/);
  });
});

describe("Icon", () => {
  it("maps size token to px and is decorative by default", () => {
    const { container } = render(<Icon icon={Heart} size="lg" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("width", "24");
    expect(svg).toHaveAttribute("height", "24");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("aria-label");
  });

  it("exposes an accessible name when label is provided", () => {
    render(<Icon icon={Heart} size="sm" label="Ulubione" />);
    const svg = screen.getByRole("img", { name: "Ulubione" });
    expect(svg).toHaveAttribute("width", "16");
    expect(svg).not.toHaveAttribute("aria-hidden");
  });
});

describe("Pill", () => {
  it("body tone reproduces the recipe-tag class set + passes color via className", () => {
    render(<Pill tone="body" className="bg-sage-mint/15 text-sage-mint border-sage-mint/30">Jagnięcina</Pill>);
    const pill = screen.getByText("Jagnięcina");
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).toContain("font-body");
    expect(pill.className).toContain("font-semibold");
    expect(pill.className).toContain("tracking-wide");
    expect(pill.className).toContain("px-3");
    expect(pill.className).toContain("py-1");
    expect(pill.className).toContain("text-xxs");
    // color passthrough
    expect(pill.className).toContain("text-sage-mint");
  });

  it("mono tone uses font-mono uppercase with no baked-in tracking", () => {
    render(<Pill tone="mono" className="tracking-[0.08em] text-teal">Postbiotyk</Pill>);
    const pill = screen.getByText("Postbiotyk");
    expect(pill.className).toContain("font-mono");
    expect(pill.className).toContain("uppercase");
    expect(pill.className).toContain("py-1.5");
    // tracking stays caller-controlled (varies per section)
    expect(pill.className).toContain("tracking-[0.08em]");
    expect(pill.className).not.toContain("font-body");
  });

  it("defaults to body tone", () => {
    render(<Pill>Domyślny</Pill>);
    expect(screen.getByText("Domyślny").className).toContain("font-body");
  });
});

describe("StepBadge", () => {
  it("renders the number and title with the teal circle", () => {
    const { container } = render(<StepBadge n={2} title="Smak puszki" />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Smak puszki" })).toBeInTheDocument();
    expect(container.querySelector(".bg-primary")).not.toBeNull();
  });

  it("merges className (e.g. centered step 3)", () => {
    const { container } = render(<StepBadge n={3} title="Stwórz puszkę" className="justify-center mb-4" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("justify-center");
    expect(wrapper.className).toContain("mb-4");
    expect(wrapper.className).not.toMatch(/\bmb-5\b/); // twMerge drops base mb-5
  });
});
