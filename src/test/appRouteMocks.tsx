import { Outlet } from "react-router-dom";
import { vi } from "vitest";

vi.mock("@/components/ui/toaster", () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => <div data-testid="sonner" />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ScrollToTop", () => ({
  default: () => <div data-testid="scroll-to-top" />,
}));

vi.mock("@/components/LanguageGate", () => ({
  default: ({ children, lang }: { children: React.ReactNode; lang: string }) => (
    <div data-lang={lang}>{children}</div>
  ),
}));

vi.mock("@/lib/useAuth", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/useCustomerAuth", () => ({
  CustomerAuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/customerAuthContext", () => ({
  useCustomerAuth: () => ({
    user: { id: "customer-test-user" },
    session: { accessToken: "customer-test-token" },
    loading: false,
    profile: { id: "customer-test-profile" },
    signInWithOtp: vi.fn(),
    signInWithOAuth: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock("@/components/admin/ProtectedRoute", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/account/CustomerProtectedRoute", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/account/CustomerPaymentRecoveryRoute", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/routes/CustomerAccountRoutes", () => ({
  CustomerLoginRoute: () => <div>Customer Login Page</div>,
  CustomerAuthCallbackRoute: () => <div>Customer Auth Callback Page</div>,
  CustomerDashboardRoute: () => <div>Customer Dashboard Page</div>,
  CustomerOrderStatusRoute: () => <div>Customer Order Status Page</div>,
  CustomerRecoverPaymentRoute: () => <div>Customer Recover Payment Page</div>,
}));

vi.mock("@/components/admin/AdminLayout", () => ({ default: () => <><div>AdminLayout</div><Outlet /></> }));
vi.mock("@/components/CookieBanner", () => ({ default: () => <div data-testid="cookie-banner" /> }));
vi.mock("@/pages/ProductPage", () => ({ default: () => <div>Product Page</div> }));
vi.mock("@/pages/SciencePage", () => ({ default: () => <div>Science Page</div> }));
vi.mock("@/pages/OurStoryPage", () => ({ default: () => <div>Our Story Page</div> }));
vi.mock("@/pages/WaitlistPage", () => ({ default: () => <div>Waitlist Public Page</div> }));
vi.mock("@/pages/skomponuj-pakiet", () => ({ default: () => <div>Configurator Page</div> }));
vi.mock("@/pages/skomponuj-pakiet/DziekujemyPage", () => ({ default: () => <div>Configurator Thank You Page</div> }));
vi.mock("@/checkout/adapters/PlatnoscNieudanaPage", () => ({ default: () => <div>Configurator Payment Failed Page</div> }));
vi.mock("@/checkout/adapters/PlatnoscPage", () => ({ default: () => <div>Configurator Payment Page</div> }));
vi.mock("@/pages/skomponuj-pakiet/TpaySimulatorPage", () => ({ default: () => <div>Configurator Tpay Simulator Page</div> }));
vi.mock("@/pages/v2/Index", () => ({ default: () => <div>Homepage V2 Page</div> }));
vi.mock("@/pages/pet-personalizer", () => ({ default: () => <div>Pet Personalizer Page</div> }));
vi.mock("@/pages/account/LoginPage", () => ({ default: () => <div>Customer Login Page</div> }));
vi.mock("@/pages/account/AuthCallbackPage", () => ({ default: () => <div>Customer Auth Callback Page</div> }));
vi.mock("@/pages/account/DashboardPage", () => ({ default: () => <div>Customer Dashboard Page</div> }));
vi.mock("@/pages/account/v2/order/AccountOrderStatusPage", () => ({ default: () => <div>Customer Order Status Page</div> }));
vi.mock("@/pages/account/RecoverPaymentPage", () => ({ default: () => <div>Customer Recover Payment Page</div> }));
vi.mock("@/pages/admin/LoginPage", () => ({ default: () => <div>Admin Login Page</div> }));
vi.mock("@/pages/admin/AuthCallbackPage", () => ({ default: () => <div>Auth Callback Page</div> }));
vi.mock("@/pages/admin/DashboardPage", () => ({ default: () => <div>Dashboard Page</div> }));
vi.mock("@/pages/admin/TestersPage", () => ({ default: () => <div>Testers Page</div> }));
vi.mock("@/pages/admin/TemplatesPage", () => ({ default: () => <div>Templates Page</div> }));
vi.mock("@/pages/admin/SettingsPage", () => ({ default: () => <div>Settings Page</div> }));
vi.mock("@/pages/admin/EmailSendsPage", () => ({ default: () => <div>Email Sends Page</div> }));
vi.mock("@/pages/admin/TesterProfilePage", () => ({ default: () => <div>Tester Profile Page</div> }));
vi.mock("@/pages/admin/PipelinePage", () => ({ default: () => <div>Pipeline Page</div> }));
vi.mock("@/pages/admin/ShipmentsPage", () => ({ default: () => <div>Shipments Page</div> }));
vi.mock("@/pages/admin/OrdersPage", () => ({ default: () => <div>Admin OMS Page</div> }));
vi.mock("@/pages/admin/RiskReviewPage", () => ({ default: () => <div>Admin Risk Page</div> }));
vi.mock("@/pages/admin/WaitlistPage", () => ({ default: () => <div>Waitlist Page</div> }));
vi.mock("@/pages/FeedbackPage", () => ({ default: () => <div>Feedback Page</div> }));
vi.mock("@/components/feedback/FeedbackRedirect", () => ({ FeedbackRedirect: () => <div>Feedback Redirect</div> }));
vi.mock("@/pages/admin/FeedbackPage", () => ({ default: () => <div>Admin Feedback Page</div> }));
vi.mock("@/pages/admin/FeedbackGalleryPage", () => ({ default: () => <div>Admin Feedback Gallery Page</div> }));
vi.mock("@/pages/admin/B2BInquiriesPage", () => ({ default: () => <div>B2B Inquiries Page</div> }));
vi.mock("@/pages/admin/SurveyResponsesPage", () => ({ default: () => <div>Survey Responses Page</div> }));
vi.mock("@/pages/PrivateLabel", () => ({ default: () => <div>Private Label Page</div> }));
vi.mock("@/pages/TermsPage", () => ({ default: () => <div>Terms Page</div> }));
vi.mock("@/pages/PolitykaPrywatnosciPage", () => ({ default: () => <div>Privacy Policy Page</div> }));
vi.mock("@/pages/RegulaminSklepuPage", () => ({ default: () => <div>Shop Terms Page</div> }));
vi.mock("@/pages/CookiePolicyPage", () => ({ default: () => <div>Cookie Policy Page</div> }));
vi.mock("@/pages/NotFound", () => ({ default: () => <div>Not Found Page</div> }));
vi.mock("@/pages/kiosk/ProducerKioskSurvey", () => ({ default: () => <div>Producer Kiosk Survey</div> }));
vi.mock("@/pages/kiosk/ConsumerKioskSurvey", () => ({ default: () => <div>Consumer Kiosk Survey</div> }));
