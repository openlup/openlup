import type { MouseEvent } from "react";
import { User } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCustomerSessionPresence } from "@/lib/useCustomerSessionPresence";

interface NavAuthLinkProps {
  /** Login destination (signed-out) and account dashboard (signed-in). */
  loginPath: string;
  accountPath: string;
  /** `bar` = desktop text link, `drawer` = mobile/tablet outline pill. */
  variant: "bar" | "drawer";
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
}

const VARIANT_CLASS: Record<NavAuthLinkProps["variant"], string> = {
  bar: "flex items-center gap-1.5 font-body font-medium text-sm text-void hover:text-primary transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white rounded-sm",
  drawer:
    "flex items-center justify-center gap-2 rounded-full border border-border text-void font-semibold py-[13px] px-8 text-sm-plus hover:border-primary hover:text-primary transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white",
};

/**
 * Customer auth entry point rendered in the V2 header, shared by the desktop
 * action bar and the mobile/tablet drawer. Signed-in customers get
 * "Moje konto" -> /konto; everyone else the login link. While the session is
 * still resolving (`null`) it renders the login variant to avoid a blank slot.
 */
export function NavAuthLink({ loginPath, accountPath, variant, onNavigate }: NavAuthLinkProps) {
  const { t } = useTranslation("common");
  const signedIn = useCustomerSessionPresence() === true;
  const href = signedIn ? accountPath : loginPath;
  const label = signedIn ? t("common:nav.myAccount") : t("common:nav.login");
  return (
    <a href={href} onClick={(event) => onNavigate(event, href)} className={VARIANT_CLASS[variant]}>
      <User size={variant === "bar" ? 16 : 18} aria-hidden="true" />
      {label}
    </a>
  );
}
