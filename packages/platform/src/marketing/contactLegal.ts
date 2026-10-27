import type { ContactContent, LegalDocumentContent } from "./contracts/contactLegal.js";

export function contactContent(facts: ContactContent) {
  return {
    supportEmail: facts.supportEmail,
    companyLines: [
      facts.organization.legalName,
      facts.addressLine,
      facts.registrationIdentifiers.map(({ label, value }) => `${label} ${value}`).join(" · "),
      ...(facts.registrationAuthority !== undefined ? [facts.registrationAuthority] : []),
    ],
  };
}

export function legalDocumentContent(content: LegalDocumentContent) {
  return {
    title: content.title,
    intro: content.intro,
    sections: content.sections.map(({ title, body }) => ({ title, body })),
    ...(content.lastUpdated !== undefined ? { lastUpdated: content.lastUpdated } : {}),
  };
}
