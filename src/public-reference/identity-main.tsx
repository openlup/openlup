import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { CustomerAuthProvider } from "@/lib/useCustomerAuth";
import { AuthProvider } from "@/lib/useAuth";
import { appQueryClient } from "@/lib/queryClient";
import LoginPage from "@/pages/account/LoginPage";
import AuthCallbackPage from "@/pages/account/AuthCallbackPage";
import OperatorLoginPage from "@/pages/admin/LoginPage";
import OperatorCallbackPage from "@/pages/admin/AuthCallbackPage";
import { IdentityAccount } from "./IdentityAccount";
import { IdentityAdmin } from "./IdentityAdmin";
import { createReferenceI18n } from "./subscriptionMessages";
import "./subscription.css";

const root = document.getElementById("root");
if (!root) throw new Error("Identity reference root is missing");
const operator = window.location.pathname.startsWith("/admin");
const direct = document.documentElement.dataset.identityAuth === "direct";
createRoot(root).render(<QueryClientProvider client={appQueryClient}>
  <I18nextProvider i18n={createReferenceI18n("en")}><BrowserRouter>
    {operator ? <AuthProvider {...(direct ? { providerKind: "direct" } : {})}><Routes>
      <Route path="/admin/login" element={<OperatorLoginPage />} />
      <Route path="/admin/auth/callback" element={<OperatorCallbackPage />} />
      <Route path="/admin" element={<IdentityAdmin />} />
    </Routes></AuthProvider> : <CustomerAuthProvider><Routes>
      <Route path="/sign-in" element={<LoginPage />} />
      <Route path="/account/auth/callback" element={<AuthCallbackPage />} />
      <Route path="/account" element={<IdentityAccount />} />
    </Routes></CustomerAuthProvider>}
  </BrowserRouter></I18nextProvider>
</QueryClientProvider>);
