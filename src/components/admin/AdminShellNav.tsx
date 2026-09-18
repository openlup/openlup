import { type FormEvent, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Boxes,
  Briefcase,
  ClipboardList,
  Clock,
  GitBranch,
  LayoutDashboard,
  LogOut,
  Mail,
  MessageSquare,
  Package,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShoppingCart,
  Tag,
  TrendingUp,
  Truck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { brandMark as veliLogo } from "#deployment-media";
import { bundleAdminEnabled } from "@/lib/bundleAdminFlag";
import { catalogAdminEnabled } from "@/lib/catalogAdminFlag";
import { isAdminOmsSurfaceAllowed, isAdminRiskSurfaceAllowed } from "@/lib/hiddenSurfaceAccess";
import { cn } from "@/lib/utils";
import { AdminShellAlerts } from "./AdminShellAlerts";
import { useOmsAttentionCount } from "./useAdminShellData";

type NavItem = {
  to: string;
  icon: LucideIcon;
  labelKey: string;
  end?: boolean;
  roles?: string[];
  hidden?: boolean;
  enabled?: () => boolean;
  /** Static discriminator; the live count is resolved inside SidebarNav so navGroups stays pure. */
  attentionKey?: "oms";
};

const omsAllowed = isAdminOmsSurfaceAllowed();
const riskAllowed = isAdminRiskSurfaceAllowed();
const navGroups: Array<{ labelKey: string; items: NavItem[] }> = [
  {
    labelKey: "admin:adminShell.groups.operations",
    items: [
      { to: "/admin", icon: LayoutDashboard, labelKey: "admin:adminShell.nav.dashboard", end: true, roles: ["admin"] },
      { to: "/admin/orders", icon: ShoppingCart, labelKey: "admin:adminShell.nav.oms", roles: ["admin"], hidden: !omsAllowed, attentionKey: "oms" },
      { to: "/admin/risk", icon: ShieldAlert, labelKey: "admin:adminShell.nav.risk", roles: ["admin"], hidden: !riskAllowed },
      { to: "/admin/shipments", icon: Truck, labelKey: "admin:adminShell.nav.shipments" },
      { to: "/admin/orders?mode=subscription_cycle", icon: Clock, labelKey: "admin:adminShell.nav.subscriptions", roles: ["admin"], hidden: !omsAllowed },
      { to: "/admin/dunning-recovery", icon: TrendingUp, labelKey: "admin:adminShell.nav.dunningRecovery", roles: ["admin"], hidden: !omsAllowed },
    ],
  },
  {
    labelKey: "admin:adminShell.groups.customers",
    items: [
      { to: "/admin/clients", icon: Users, labelKey: "admin:adminShell.nav.customers", roles: ["admin"] },
      { to: "/admin/testers", icon: ClipboardList, labelKey: "admin:adminShell.nav.testers", roles: ["admin"] },
      { to: "/admin/b2b-inquiries", icon: Briefcase, labelKey: "admin:adminShell.nav.b2b", roles: ["admin"] },
      { to: "/admin/feedback", icon: MessageSquare, labelKey: "admin:adminShell.nav.feedback", roles: ["admin"] },
      { to: "/admin/waitlist", icon: Clock, labelKey: "admin:adminShell.nav.waitlist", roles: ["admin"] },
    ],
  },
  {
    labelKey: "admin:adminShell.groups.sales",
    items: [
      { to: "/admin/catalog", icon: Boxes, labelKey: "admin:adminShell.nav.catalog", roles: ["admin"], enabled: catalogAdminEnabled },
      { to: "/admin/bundles", icon: Package, labelKey: "admin:adminShell.nav.bundles", roles: ["admin"], enabled: bundleAdminEnabled },
      { to: "/admin/promotions", icon: Tag, labelKey: "admin:adminShell.nav.promotions", roles: ["admin"], enabled: () => true },
      { to: "/admin/pipeline", icon: GitBranch, labelKey: "admin:adminShell.nav.pipeline", roles: ["admin"] },
    ],
  },
  {
    labelKey: "admin:adminShell.groups.communication",
    items: [
      { to: "/admin/templates", icon: Mail, labelKey: "admin:adminShell.nav.templates", roles: ["admin"] },
      { to: "/admin/email-sends", icon: Send, labelKey: "admin:adminShell.nav.emailSends", roles: ["admin"] },
    ],
  },
  {
    labelKey: "admin:adminShell.groups.system",
    items: [
      { to: "/admin/settings", icon: Settings, labelKey: "admin:adminShell.nav.settings", roles: ["admin"] },
      { to: "/admin/survey-responses", icon: ClipboardList, labelKey: "admin:adminShell.nav.surveys", roles: ["admin"] },
    ],
  },
];

function visibleGroups(role: string | null | undefined) {
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items
        .filter((item) => !item.hidden)
        .filter((item) => !item.roles || item.roles.includes(role ?? "admin"))
        .filter((item) => !item.enabled || item.enabled()),
    }))
    .filter((group) => group.items.length > 0);
}

export function SidebarNav({
  role,
  email,
  onSignOut,
  onNavigate,
}: {
  role: string | null | undefined;
  email: string | undefined;
  onSignOut: () => void;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation("admin");
  const groups = useMemo(() => visibleGroups(role), [role]);
  const omsAttention = useOmsAttentionCount();
  return (
    <div className="flex h-full flex-col bg-offwhite text-teal-dark">
      <div className="flex h-[60px] items-center gap-3 border-b border-warm-sand px-4">
        <img src={veliLogo} alt="openlup" className="h-5 w-auto" />
        <span className="label-text text-text-muted">{t("admin:adminShell.panel")}</span>
      </div>
      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
        {groups.map((group) => (
          <div key={group.labelKey} className="grid gap-1.5">
            <p className="px-2 text-xxs font-bold uppercase text-text-muted">{t(group.labelKey)}</p>
            {group.items.map(({ to, icon: Icon, labelKey, end, attentionKey }) => {
              const attention = attentionKey === "oms" ? omsAttention : null;
              return (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    "focus-ring flex min-h-[44px] items-center gap-3 rounded-xl px-3 py-2 text-xs-plus font-bold transition",
                    isActive ? "bg-white text-teal-dark shadow-sm" : "text-text-muted hover:bg-white/70 hover:text-teal-dark",
                  )
                }
              >
                <Icon size={17} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
                {attention ? (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warm-coral px-1.5 text-xxs font-bold text-teal-dark">
                    {attention}
                  </span>
                ) : null}
              </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="border-t border-warm-sand p-3">
        <div className="mb-2 rounded-xl bg-white px-3 py-2">
          <p className="text-xxs font-bold uppercase text-text-muted">{t("admin:adminShell.operator")}</p>
          <p className="truncate text-xs-plus font-semibold text-teal-dark">{email}</p>
        </div>
        <button onClick={onSignOut} className="focus-ring flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-xs-plus font-bold text-text-muted transition hover:bg-white hover:text-teal-dark">
          <LogOut size={17} aria-hidden="true" />
          {t("admin:adminShell.signOut")}
        </button>
      </div>
    </div>
  );
}

/** Which surface the global search box submits into. */
export type AdminSearchScope = "orders" | "clients";

const SEARCH_SCOPE_COPY: Record<AdminSearchScope, { labelKey: string; placeholderKey: string }> = {
  orders: {
    labelKey: "admin:adminShell.searchLabel",
    placeholderKey: "admin:adminShell.searchPlaceholder",
  },
  clients: {
    labelKey: "admin:adminShell.searchClientsLabel",
    placeholderKey: "admin:adminShell.searchClientsPlaceholder",
  },
};

/**
 * Only the role that gets the `/admin/clients` nav item gets the customer scope, so the
 * switch never offers a surface the acting role would just be bounced from. Mirrors the
 * sidebar `roles` filter, which reads an unresolved role as admin.
 */
function searchScopesFor(role: string | null | undefined): AdminSearchScope[] {
  return (role ?? "admin") === "admin" ? ["orders", "clients"] : ["orders"];
}

export function TopBar({
  email,
  role,
  onSearch,
}: {
  email: string | undefined;
  role: string | null | undefined;
  onSearch: (query: string, scope: AdminSearchScope) => void;
}) {
  const { t } = useTranslation("admin");
  const { pathname } = useLocation();
  const [query, setQuery] = useState("");
  const scopes = useMemo(() => searchScopesFor(role), [role]);
  // Seeded from the route once, then owned by the operator: re-deriving it on every
  // navigation would silently undo the scope they just picked.
  const [scope, setScope] = useState<AdminSearchScope>(() =>
    pathname.startsWith("/admin/clients") ? "clients" : "orders",
  );
  const activeScope = scopes.includes(scope) ? scope : scopes[0];
  const initials = (email ?? "OV").slice(0, 2).toUpperCase();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length >= 2) onSearch(trimmed, activeScope);
  }

  return (
    <header className="sticky top-0 z-header flex h-[60px] items-center gap-3 border-b border-warm-sand bg-offwhite/95 px-4 backdrop-blur">
      <form onSubmit={submit} className="hidden w-full max-w-2xl items-center gap-2 md:flex">
        {scopes.length > 1 ? (
          <div className="flex shrink-0 gap-1" role="group" aria-label={t("admin:adminShell.searchScopeLabel")}>
            {scopes.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={activeScope === option}
                onClick={() => setScope(option)}
                className={cn(
                  "focus-ring rounded-full border px-3 py-1 text-xxs font-bold transition",
                  activeScope === option
                    ? "border-teal bg-teal text-white"
                    : "border-warm-sand bg-white text-text-muted hover:border-teal hover:text-teal-dark",
                )}
              >
                {t(`admin:adminShell.searchScopes.${option}`)}
              </button>
            ))}
          </div>
        ) : null}
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t(SEARCH_SCOPE_COPY[activeScope].labelKey)}
            placeholder={t(SEARCH_SCOPE_COPY[activeScope].placeholderKey)}
            className="focus-ring h-9 w-full rounded-control border border-warm-sand bg-white pl-9 pr-12 text-xs-plus font-medium text-teal-dark placeholder:text-text-muted"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md border border-warm-sand px-1.5 py-0.5 text-xxs font-bold text-text-muted">
            {t("admin:adminShell.commandKey")}
          </span>
        </div>
      </form>
      <div className="ml-auto flex items-center gap-2">
        <AdminShellAlerts />
        <div className="flex min-h-9 items-center gap-2 rounded-full bg-white px-2 pr-3">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-light-teal text-xxs font-bold text-teal-dark">{initials}</span>
          <div className="hidden leading-tight sm:block">
            <p className="text-xs font-bold text-teal-dark">{t("admin:adminShell.operator")}</p>
            <p className="max-w-32 truncate text-xxs text-text-muted">{email}</p>
          </div>
        </div>
      </div>
    </header>
  );
}
