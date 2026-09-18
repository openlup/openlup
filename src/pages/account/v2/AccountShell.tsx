import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ChevronDown,
  Home,
  LogOut,
  Mail,
  MapPin,
  Package,
  PawPrint,
  Pencil,
  ReceiptText,
  Repeat,
  ShoppingBag,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { brandMark as veliLogo } from "#deployment-media";
import { cn } from "@/lib/utils";
import { useLocalizedPath } from "@/lib/i18nRoutes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * AccountShell (V2) — cream chrome for the redesigned customer account:
 * sticky top bar + left sidebar navigation + help tile + content slot.
 * Pure layout: tab state lives in the workspace. Sidebar is real navigation
 * (`<nav>` + `aria-current="page"`), not a tablist. See design handoff §1.
 */

export type AccountV2TabId =
  | "start"
  | "subscriptions"
  | "orders"
  | "pets"
  | "addresses"
  | "payments"
  | "communication"
  | "billing";

const NAV_ITEMS: ReadonlyArray<{ id: AccountV2TabId; icon: LucideIcon }> = [
  { id: "start", icon: Home },
  { id: "subscriptions", icon: Repeat },
  { id: "orders", icon: Package },
  { id: "pets", icon: PawPrint },
  { id: "addresses", icon: MapPin },
  { id: "payments", icon: Wallet },
  { id: "communication", icon: Mail },
  { id: "billing", icon: ReceiptText },
];

function initialsOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "·";
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="h-[34px] w-[34px] rounded-full object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-teal/15 font-display text-sm font-semibold text-teal-dark"
    >
      {initialsOf(name)}
    </span>
  );
}

export function AccountShell({
  greetingName,
  avatarUrl,
  activeTab,
  onTabChange,
  attentionTabs,
  shopHref,
  onSignOut,
  onEditProfile,
  children,
}: {
  greetingName: string;
  avatarUrl: string | null;
  activeTab: AccountV2TabId;
  onTabChange: (tab: AccountV2TabId) => void;
  attentionTabs?: ReadonlySet<AccountV2TabId>;
  shopHref?: string;
  onSignOut?: () => void;
  onEditProfile?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("account");
  const localizedPath = useLocalizedPath();
  const shop = shopHref ?? localizedPath("home");

  return (
    <div className="min-h-screen bg-background font-body text-foreground">
      {/* Top bar */}
      <header className="sticky top-0 z-header h-16 border-b border-teal-dark/8 bg-offwhite/85 backdrop-blur">
        <div className="mx-auto flex h-full max-w-[1320px] items-center justify-between px-4 sm:px-7">
          <div className="flex items-center gap-3">
            <img src={veliLogo} alt="openlup" className="h-6 w-auto" />
            <span className="h-5 w-px bg-teal-dark/15" aria-hidden />
            <span className="font-display text-base font-semibold text-foreground">
              {t("account:dashboard.shell.brandLabel")}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href={shop}
              className="focus-ring inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground motion-reduce:transition-none"
            >
              <ShoppingBag size={17} className="shrink-0" />
              <span className="hidden sm:inline">
                {t("account:dashboard.shell.shop")}
              </span>
            </a>
            {onEditProfile || onSignOut ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t("account:dashboard.shell.accountMenu")}
                  className="focus-ring flex items-center gap-2 rounded-control"
                >
                  <Avatar src={avatarUrl} name={greetingName} />
                  {greetingName ? (
                    <span className="hidden text-sm font-semibold text-foreground sm:inline">
                      {greetingName}
                    </span>
                  ) : null}
                  <ChevronDown size={14} className="text-foreground/40" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="account-light">
                  {onEditProfile ? (
                    <DropdownMenuItem onClick={onEditProfile} className="gap-2">
                      <Pencil size={15} />
                      {t("account:dashboard.shell.editProfile")}
                    </DropdownMenuItem>
                  ) : null}
                  {onEditProfile && onSignOut ? <DropdownMenuSeparator /> : null}
                  {onSignOut ? (
                    <DropdownMenuItem onClick={onSignOut} className="gap-2">
                      <LogOut size={15} />
                      {t("account:dashboard.signOut")}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="flex items-center gap-2">
                <Avatar src={avatarUrl} name={greetingName} />
                {greetingName ? (
                  <span className="hidden text-sm font-semibold text-foreground sm:inline">
                    {greetingName}
                  </span>
                ) : null}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Body: sidebar + content */}
      <div className="mx-auto grid max-w-[1320px] grid-cols-1 items-start gap-7 px-4 py-7 sm:px-7 lg:grid-cols-[232px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-[92px]">
          <nav
            aria-label={t("account:dashboard.shell.navLabel")}
            className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0"
          >
            {NAV_ITEMS.map(({ id, icon: Icon }) => {
              const active = id === activeTab;
              const attention = attentionTabs?.has(id) ?? false;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onTabChange(id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "focus-ring flex shrink-0 items-center gap-3 rounded-control px-3.5 py-3 text-left text-sm transition-all duration-150 motion-reduce:transition-none lg:w-full",
                    active
                      ? "bg-card font-bold text-foreground shadow-card"
                      : "font-medium text-foreground/70 hover:bg-card/60 hover:text-foreground",
                  )}
                >
                  <Icon
                    size={18}
                    className={cn("shrink-0", active ? "text-teal" : "text-foreground/55")}
                  />
                  <span className="flex-1">
                    {t(`account:dashboard.shell.nav.${id}`)}
                  </span>
                  {attention ? (
                    <span
                      className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warm-coral px-1.5 text-xxs font-bold text-white"
                      aria-label={t("account:dashboard.shell.attention")}
                    >
                      1
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>

          <div className="mt-4 hidden rounded-card bg-teal/[0.07] p-4 lg:block">
            <p className="text-sm text-foreground/70">
              {t("account:dashboard.shell.help.title")}
            </p>
            <a
              href={`mailto:${t("account:dashboard.shell.help.email")}`}
              className="focus-ring mt-1.5 inline-flex items-center gap-1 text-sm font-semibold text-teal hover:underline"
            >
              {t("account:dashboard.shell.help.email")}
              <ArrowRight size={14} className="shrink-0" />
            </a>
          </div>

        </aside>

        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
