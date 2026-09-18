import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        "outline-solid": "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        // Brand marketing CTAs — see DESIGN.md §2. Colors come from the semantic
        // --cta* tokens (Signal Teal primary / Lilac secondary), NOT a raw hue,
        // so the action color is re-themable in one place.
        // transition-all (not base transition-colors) so scale/brightness animate.
        "cta-marketing":
          "rounded-full font-body font-semibold bg-cta text-cta-foreground shadow-cta transition-all duration-200 hover:brightness-110 hover:scale-[1.03]",
        "cta-marketing-outline":
          "rounded-full font-body font-semibold border-2 border-cta text-cta bg-transparent transition-all duration-200 hover:bg-cta hover:text-cta-foreground",
        // Secondary action — lower emphasis than primary (outline, fills on hover).
        "cta-secondary":
          "rounded-full font-body font-semibold border-2 border-cta-secondary text-cta-secondary bg-transparent transition-all duration-200 hover:bg-cta-secondary hover:text-cta-secondary-foreground",
        "cta-teal":
          "rounded-full font-body font-semibold bg-teal text-void transition-all duration-200 hover:bg-teal-dark hover:text-white",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
        // Brand CTA sizes (see DESIGN.md §3 type scale).
        hero: "text-base-plus px-12 py-[18px]",
        section: "text-sm-plus px-8 py-[14px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
