import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Menu } from "lucide-react";
import { brandMark as veliLogo } from "#deployment-media";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/lib/authContext";
import { SidebarNav, TopBar, type AdminSearchScope } from "./AdminShellNav";

/** Both destinations already read the query from `?q=`, so the scope only picks a path. */
const SEARCH_SCOPE_PATHS: Record<AdminSearchScope, string> = {
  orders: "/admin/orders",
  clients: "/admin/clients",
};

export default function AdminLayout() {
  const { t } = useTranslation("admin");
  const { signOut, user, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (role === "distributor" && location.pathname.replace(/\/+$/, "") === "/admin") {
      navigate("/admin/shipments", { replace: true });
    }
  }, [location.pathname, navigate, role]);

  async function handleSignOut() {
    setDrawerOpen(false);
    await signOut();
    navigate("/admin/login");
  }

  function handleSearch(query: string, scope: AdminSearchScope) {
    navigate(`${SEARCH_SCOPE_PATHS[scope]}?q=${encodeURIComponent(query)}`);
    setDrawerOpen(false);
  }

  if (isMobile) {
    return (
      <div className="flex h-screen flex-col bg-offwhite text-teal-dark">
        <header className="sticky top-0 z-header flex h-[60px] items-center justify-between border-b border-warm-sand bg-offwhite/95 px-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <img src={veliLogo} alt="openlup" className="h-5 w-auto" />
            <span className="label-text text-text-muted">{t("admin:adminShell.panel")}</span>
          </div>
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <button aria-label={t("admin:adminShell.openMenu")} className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-warm-sand bg-white text-teal-dark">
                <Menu size={22} aria-hidden="true" />
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 border-r border-warm-sand bg-offwhite p-0 text-teal-dark">
              <SidebarNav role={role} email={user?.email} onSignOut={handleSignOut} onNavigate={() => setDrawerOpen(false)} />
            </SheetContent>
          </Sheet>
        </header>
        <main className="flex-1 overflow-y-auto bg-offwhite">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-offwhite text-teal-dark">
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-warm-sand bg-offwhite">
        <SidebarNav role={role} email={user?.email} onSignOut={handleSignOut} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar email={user?.email} role={role} onSearch={handleSearch} />
        <main className="flex-1 overflow-y-auto bg-offwhite">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
