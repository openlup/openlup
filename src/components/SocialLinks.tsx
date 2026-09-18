import type { SVGProps } from "react";
import { useTranslation } from "react-i18next";

import { APP_SOCIAL_LINKS } from "@/lib/brand/appBrand";
import type { SocialNetwork } from "@/lib/brand/brandConfig";

type Variant = "nav" | "footer";

interface SocialLinksProps {
  /** `nav`: same ikony (pasek i szuflada mobilna). `footer`: ikona + nazwa sieci, jako lista linków w kolumnie stopki. */
  variant: Variant;
  className?: string;
}

// Ikony inline zamiast react-icons: dwie ścieżki SVG to ~1 KB i nie dodają
// nowego chunku do budżetu wydajności; lucide-react nie ma ikon marek.
const InstagramIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
  </svg>
);

const FacebookIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
  </svg>
);

const NETWORKS: { key: SocialNetwork; name: string; Icon: typeof InstagramIcon }[] = [
  { key: "instagram", name: "Instagram", Icon: InstagramIcon },
  { key: "facebook", name: "Facebook", Icon: FacebookIcon },
];

const CONFIGURED_NETWORKS = NETWORKS.flatMap((network) => {
  const href = APP_SOCIAL_LINKS[network.key];
  return href ? [{ ...network, href }] : [];
});

export const HAS_SOCIAL_LINKS = CONFIGURED_NETWORKS.length > 0;

/** Profile supplied by the deployment owner; an unconfigured public default renders nothing. */
export function SocialLinks({ variant, className = "" }: SocialLinksProps) {
  const { t } = useTranslation("common");

  if (!HAS_SOCIAL_LINKS) return null;

  if (variant === "footer") {
    return (
      <div className={`space-y-3 font-body text-sm text-text-on-dark ${className}`}>
        {CONFIGURED_NETWORKS.map(({ key, name, Icon, href }) => (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t(`common:social.${key}`)}
            className="flex items-center gap-2.5 hover:text-offwhite transition-colors"
          >
            <Icon className="w-4 h-4 shrink-0" />
            {name}
          </a>
        ))}
      </div>
    );
  }

  return (
    <div className={`flex items-center ${className}`} role="group" aria-label={t("common:social.label")}>
      {CONFIGURED_NETWORKS.map(({ key, Icon, href }) => (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t(`common:social.${key}`)}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-void hover:text-primary transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Icon className="w-[18px] h-[18px]" />
        </a>
      ))}
    </div>
  );
}
