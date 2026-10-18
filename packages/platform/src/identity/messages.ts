type Role = "admin" | "distributor";
const roleName = (role: Role) => role === "admin" ? "Admin" : "Dystrybutor";
const en = {
  unauthorized: "Unauthorized", invalidToken: "Invalid token",
  inviteForbidden: "Only admins may invite users", emailRequired: "Email required",
  invalidRole: "Invalid role", alreadyAdded: "This user is already added",
  addFailed: (detail: string) => `Adding user failed: ${detail}`,
  notificationFailed: (detail: string) => `Role added, but notification failed: ${detail}`,
  roleAddedDisabled: (email: string, role: Role) => `User ${email} already had an account; added role ${role}, but notification was disabled and not sent.`,
  roleAddedSuppressed: (email: string, role: Role) => `User ${email} already had an account; added role ${role}, but notification was suppressed and not sent.`,
  roleAdded: (email: string, role: Role) => `User ${email} already had an account; added role ${role} and sent a notification.`,
  inviteFailed: (detail: string) => `Invitation failed: ${detail}`,
  roleInsertFailed: (detail: string) => `Account created, but adding role failed: ${detail}`,
  invited: (email: string, role: Role) => `Invitation with role ${role} sent to ${email}`,
  removeForbidden: "Only admins may revoke user access", userIdRequired: "User ID required",
  selfRemoveForbidden: "You cannot revoke your own access",
  lastAdmin: "At least one active human admin must remain.",
  selfRevoke: "You cannot revoke your own access.",
  machineRevoke: "Machine actors cannot be revoked through this route.",
  adminNotFound: "Admin user not found.", adminRequired: "Admin role required.",
  revokeFailed: (detail: string) => `Admin access revoke failed: ${detail}`,
};
export type IdentityMessages = typeof en;
export const identityMessages: Readonly<Record<"en" | "pl", IdentityMessages>> = {
  en,
  pl: {
    ...en,
    inviteForbidden: "Tylko admini mogą zapraszać użytkowników", emailRequired: "Brak emaila",
    invalidRole: "Nieprawidłowa rola", alreadyAdded: "Ten użytkownik jest już dodany",
    addFailed: (detail) => `Błąd dodawania: ${detail}`,
    notificationFailed: (detail) => `Rola dodana, ale nie udało się wysłać powiadomienia: ${detail}`,
    roleAddedDisabled: (email, role) => `Użytkownik ${email} już miał konto — dodano rolę ${roleName(role)}, ale powiadomienie było wyłączone i nie zostało wysłane.`,
    roleAddedSuppressed: (email, role) => `Użytkownik ${email} już miał konto — dodano rolę ${roleName(role)}, ale wysłanie powiadomienia zostało zablokowane i nie zostało wysłane.`,
    roleAdded: (email, role) => `Użytkownik ${email} już miał konto — dodano rolę ${roleName(role)} i wysłano powiadomienie.`,
    inviteFailed: (detail) => `Błąd zaproszenia: ${detail}`,
    roleInsertFailed: (detail) => `Konto utworzone, ale błąd dodawania roli: ${detail}`,
    invited: (email, role) => `Zaproszenie z rolą ${roleName(role)} wysłane na ${email}`,
    removeForbidden: "Tylko administratorzy mogą odbierać dostęp użytkownikom",
    userIdRequired: "Brak ID użytkownika", selfRemoveForbidden: "Nie możesz odebrać sobie dostępu",
  },
};
