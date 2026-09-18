import { validateEmailField } from "@/lib/schemas/fields";

export function normalizeAdminInviteEmail(value: unknown): string {
  const email = validateEmailField(value);
  if (!email.success) throw new Error("Niepoprawny email");
  return email.value;
}
