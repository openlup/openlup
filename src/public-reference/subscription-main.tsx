import { createRoot, hydrateRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { ReferenceAccount, ReferenceAuthCallback, ReferenceSubscribe } from "./SubscriptionAccount";
import { createReferenceI18n } from "./subscriptionMessages";
import { PublicReferenceApp } from "./App";
import "./subscription.css";

const root = document.getElementById("root");
if (!root) throw new Error("Subscription reference root is missing");

const path = window.location.pathname;
if (path !== "/subscribe" && path !== "/account" && path !== "/account/auth/callback") {
  hydrateRoot(root, <PublicReferenceApp pathname={path} />);
} else {
const page = path === "/subscribe" ? <ReferenceSubscribe />
  : path === "/account" ? <ReferenceAccount />
  : <ReferenceAuthCallback />;

createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nextProvider i18n={createReferenceI18n()}>{page}</I18nextProvider>
  </QueryClientProvider>,
);
}
