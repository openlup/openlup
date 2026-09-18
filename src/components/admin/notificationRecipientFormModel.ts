import { validateEmailField, validateNameField } from "@/lib/schemas/fields";

export interface NotificationRecipientInput {
  email: string;
  name: string;
}

export interface NotificationRecipientFormPayload {
  email: string;
  name: string | null;
}

export function parseNotificationRecipientInput(
  input: NotificationRecipientInput,
): NotificationRecipientFormPayload {
  const email = validateEmailField(input.email);
  const name = validateNameField(input.name, { required: false });

  if (!email.success) throw new Error("Niepoprawny email");
  if (!name.success) throw new Error("Niepoprawne imię");

  return {
    email: email.value,
    name: name.value || null,
  };
}
