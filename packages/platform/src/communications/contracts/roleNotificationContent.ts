import type { Locale } from "./email.js";
import { button, heading, paragraph, type EmailBlock } from "./blocks.js";

export interface RoleNotificationVars {
  role: "admin" | "distributor";
  operatorUrl: string;
  /** Absent means active membership; present means a pending invitation. */
  expiresAt?: string;
}
export interface RoleNotificationCopy {
  subject: string;
  heading: string;
  status: string;
  body: string;
  button: string;
  footer: string;
}
export type RoleNotificationCopyFactory = (role: RoleNotificationVars["role"], expiresAt?: string) => RoleNotificationCopy;

function defaultCopy(locale: Locale, role: RoleNotificationVars["role"], expiresAt?: string): RoleNotificationCopy {
  return expiresAt === undefined ? (locale === "pl" ? {
    subject: `Uprawnienia operatora: ${role}`,
    heading: "Uprawnienia operatora",
    status: "Twoje uprawnienia operatora są aktywne.",
    body: `Przyznano Ci rolę ${role}. Otwórz panel operatora, aby się zalogować.`,
    button: "Otwórz panel operatora",
    footer: "Jeśli nie oczekujesz tych uprawnień, skontaktuj się z zespołem aplikacji.",
  } : {
    subject: `Operator membership: ${role}`,
    heading: "Operator membership",
    status: "Your operator membership is active.",
    body: `You have the ${role} role. Open the operator panel to sign in.`,
    button: "Open operator panel",
    footer: "If you did not expect this membership, contact the application team.",
  }) : locale === "pl" ? {
    subject: `Zaproszenie operatora: ${role}`,
    heading: "Zaproszenie operatora",
    status: `Zaproszenie oczekuje na przyjęcie do ${expiresAt}.`,
    body: `Zaproszono Cię do roli ${role}. Dostęp rozpocznie się po wejściu do panelu operatora ze zweryfikowanym kontem.`,
    button: "Otwórz panel operatora",
    footer: "Jeśli nie oczekujesz tego zaproszenia, skontaktuj się z zespołem aplikacji.",
  } : {
    subject: `Operator invitation: ${role}`,
    heading: "Operator invitation",
    status: `Your invitation is pending until ${expiresAt}.`,
    body: `You are invited as ${role}. Access begins when you enter the operator panel with your verified account.`,
    button: "Open operator panel",
    footer: "If you did not expect this invitation, contact the application team.",
  };
}
const defaults: Record<Locale, RoleNotificationCopyFactory> = {
  pl: (role, expiresAt) => defaultCopy("pl", role, expiresAt),
  en: (role, expiresAt) => defaultCopy("en", role, expiresAt),
};

/** Pure defaults with the same active/pending semantics in both locales. */
export function createRoleNotificationContentFactory(copy: Record<Locale, RoleNotificationCopyFactory> = defaults) {
  function roleNotificationEmailContent(locale: Locale, vars: RoleNotificationVars): { subject: string; preheader: string; blocks: EmailBlock[] } {
    const c = copy[locale](vars.role, vars.expiresAt);
    return { subject: c.subject, preheader: c.status,
      blocks: [heading(c.heading), paragraph(c.status), paragraph(c.body),
        button(c.button, vars.operatorUrl), paragraph(c.footer, { muted: true })] };
  }
  return { roleNotificationEmailContent };
}
