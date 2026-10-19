import { useEffect } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider, useTranslation } from "react-i18next";
import { ReferenceAccount, ReferenceSubscribe } from "./SubscriptionAccount";
import { createReferenceI18n } from "./subscriptionMessages";
import { PublicReferenceApp } from "./App";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { CustomerAuthProvider } from "@/lib/useCustomerAuth";
import { appQueryClient } from "@/lib/queryClient";
import LoginPage from "@/pages/account/LoginPage";
import AuthCallbackPage from "@/pages/account/AuthCallbackPage";
import "./subscription.css";

function CustomerPages() {
  const { pathname } = useLocation();
  const { i18n } = useTranslation();
  const language = pathname.startsWith('/konto') || pathname === '/zaloguj-sie' ? 'pl' : 'en';
  useEffect(() => { void i18n.changeLanguage(language); }, [i18n, language]);
  return <Routes>
          <Route path="/subscribe" element={<ReferenceSubscribe />} />
          {['/sign-in', '/zaloguj-sie'].map((route) => <Route key={route} path={route} element={<LoginPage />} />)}
          {['/account/auth/callback', '/konto/auth/callback'].map((route) => <Route key={route} path={route} element={<AuthCallbackPage />} />)}
          {['/account', '/konto'].map((route) => <Route key={route} path={route} element={<ReferenceAccount />} />)}
        </Routes>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Subscription reference root is missing");

const path = window.location.pathname;
if (!["/subscribe", "/account", "/konto", "/sign-in", "/zaloguj-sie", "/account/auth/callback", "/konto/auth/callback"].includes(path)) {
  hydrateRoot(root, <PublicReferenceApp pathname={path} />);
} else {
  createRoot(root).render(
    <QueryClientProvider client={appQueryClient}>
      <I18nextProvider i18n={createReferenceI18n(path.startsWith('/konto') || path === '/zaloguj-sie' ? 'pl' : 'en')}>
        <BrowserRouter><CustomerAuthProvider><CustomerPages /></CustomerAuthProvider></BrowserRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}
