import { z } from "../../lib/validation/zod.js";
import { validateEmailField } from "@/lib/schemas/fields";

export const B2B_COUNTRIES = [
  { code: "AU", label: "Australia" },
  { code: "AT", label: "Austria" },
  { code: "BE", label: "Belgium" },
  { code: "CA", label: "Canada" },
  { code: "CZ", label: "Czechia" },
  { code: "DK", label: "Denmark" },
  { code: "FI", label: "Finland" },
  { code: "FR", label: "France" },
  { code: "DE", label: "Germany" },
  { code: "IE", label: "Ireland" },
  { code: "IT", label: "Italy" },
  { code: "NL", label: "Netherlands" },
  { code: "NZ", label: "New Zealand" },
  { code: "NO", label: "Norway" },
  { code: "PL", label: "Poland" },
  { code: "PT", label: "Portugal" },
  { code: "SK", label: "Slovakia" },
  { code: "ES", label: "Spain" },
  { code: "SE", label: "Sweden" },
  { code: "CH", label: "Switzerland" },
  { code: "GB", label: "United Kingdom" },
  { code: "US", label: "United States" },
  { code: "OTHER", label: "Other" },
];

const BLOCKED_EMAIL_DOMAINS = [
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.es",
  "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com",
  "protonmail.com", "proton.me",
  "mail.com", "mail.ru",
  "gmx.com", "gmx.net", "gmx.de",
  "yandex.com", "yandex.ru",
  "wp.pl", "onet.pl", "interia.pl", "o2.pl", "tlen.pl", "op.pl", "gazeta.pl",
];

function isBlockedDomain(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return BLOCKED_EMAIL_DOMAINS.includes(domain);
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function addIssue(ctx: z.RefinementCtx, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });
}

function requiredTextField({
  max,
  requiredMessage,
  minMessage,
  maxMessage,
}: {
  max: number;
  requiredMessage: string;
  minMessage: string;
  maxMessage: string;
}) {
  return z
    .string()
    .superRefine((rawValue, ctx) => {
      const value = normalizeText(rawValue);

      if (!value) {
        addIssue(ctx, requiredMessage);
        return;
      }

      if (value.length < 2) {
        addIssue(ctx, minMessage);
      }

      if (rawValue.length > max) {
        addIssue(ctx, maxMessage);
      }
    })
    .transform(normalizeText);
}

export const privateLabelSchema = z.object({
  company: requiredTextField({
    max: 100,
    requiredMessage: "forms:fields.company.required",
    minMessage: "forms:fields.company.tooShort",
    maxMessage: "forms:fields.company.tooLong",
  }),
  country: z.string().min(1, "forms:fields.country.required"),
  firstName: requiredTextField({
    max: 50,
    requiredMessage: "forms:fields.name.required",
    minMessage: "forms:fields.name.tooShort",
    maxMessage: "forms:fields.name.tooLong",
  }),
  lastName: requiredTextField({
    max: 50,
    requiredMessage: "forms:fields.name.required",
    minMessage: "forms:fields.name.tooShort",
    maxMessage: "forms:fields.name.tooLong",
  }),
  email: z
    .string()
    .superRefine((rawValue, ctx) => {
      const email = validateEmailField(rawValue);
      if (!email.success) {
        addIssue(ctx, email.errors[0]?.messageKey ?? "forms:fields.email.invalid");
        return;
      }

      if (isBlockedDomain(email.value)) {
        addIssue(ctx, "b2b:form.freeEmailDomain");
      }
    })
    .transform((value) => validateEmailField(value).value),
  phone: z
    .string()
    .superRefine((rawValue, ctx) => {
      const value = rawValue.trim();
      if (!value) return;

      if (!/^[+\d\s\-().]+$/.test(value)) {
        addIssue(ctx, "forms:fields.phone.invalid");
        return;
      }

      const digits = value.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) {
        addIssue(ctx, "forms:fields.phone.invalid");
      }
    })
    .transform((value) => value.trim()),
  notes: z
    .string()
    .superRefine((value, ctx) => {
      if (value.length > 1000) {
        addIssue(ctx, "b2b:form.notesTooLong");
      }
    })
    .transform((value) => value.trim()),
});

export type PrivateLabelFormValues = z.infer<typeof privateLabelSchema>;

export const PRIVATE_LABEL_INITIAL_VALUES = {
  company: "",
  country: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  notes: "",
} satisfies Record<keyof PrivateLabelFormValues, string>;
