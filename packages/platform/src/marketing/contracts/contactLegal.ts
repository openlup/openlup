export interface OrganizationFacts {
  name: string;
  legalName: string;
  url: string;
  logo: { url: string; contentUrl: string; width: number; height: number };
  email: string;
  vatID: string;
  taxID: string;
  areaServed: string;
  sameAs: string[];
  contactPoint: { email: string; contactType: string; availableLanguage: string[] };
  address: {
    streetAddress: string;
    addressLocality: string;
    postalCode: string;
    addressRegion: string;
    addressCountry: string;
  };
}

export interface ContactContent {
  organization: OrganizationFacts;
  supportEmail: string;
  addressLine: string;
  registrationIdentifiers: { label: string; value: string }[];
  registrationAuthority?: string;
}

export interface LegalDocumentContent {
  title: string;
  intro: string;
  sections: { title: string; body: string }[];
  lastUpdated?: string;
}

export interface PrivacyProcessorDisclosure {
  processorName: string;
  purpose: string;
  dataCategories: string[];
  details?: string;
}
