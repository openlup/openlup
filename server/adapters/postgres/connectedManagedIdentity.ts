import type { Pool } from "pg";
import { deriveOidcPrincipalId } from "@openlup/platform/identity";
import { PostgresTransferError } from "@openlup/platform/portability";
import type { ConnectedNativeStoreCapture } from "./connectedStoreCapture.js";
import {
  copyCapture,
  quoteRestoreIdentifier,
  rehashCapturePacket,
  replaceTargetRows,
} from "./connectedTransferPacket.js";

/** Explicit source evidence for the finite managed identity portion of a transfer. */
export interface ManagedIdentityMappingSource {
  sourceId: string;
  issuer: string;
  observation: ConnectedNativeStoreCapture["observation"];
  subjects: readonly { managedId: string; subject: string }[];
  clients: readonly Record<string, unknown>[];
  adminUsers: readonly Record<string, unknown>[];
  revokeAudit: readonly Record<string, unknown>[];
  erasures: readonly Record<string, unknown>[];
  lifecycleEvents: readonly Record<string, unknown>[];
}

export interface ManagedIdentityMappingResult {
  packet: ConnectedNativeStoreCapture;
  subjects: readonly { managedId: string; issuer: string; subject: string; principalId: string }[];
  auditReferences: readonly { sourceId: string; sourceRowId: string; targetAuditId: string }[];
}

function fail(code: "invalid_input" | "target_conflict", table?: string): never {
  throw new PostgresTransferError(code, table);
}

/**
 * Translate only the explicitly evidenced identity portion into #414's fixed
 * qualified-target capture. The caller owns source snapshot/completeness proof;
 * this routine never treats an email or raw managed UUID as an OIDC subject.
 */
export async function mapManagedIdentityForConnectedRestore(input: {
  source: ManagedIdentityMappingSource;
  freshTarget: ConnectedNativeStoreCapture;
  targetOwner: Pool;
}): Promise<ManagedIdentityMappingResult> {
  const source = structuredClone(input.source);
  const packet = copyCapture(input.freshTarget);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validRow = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const onlyKeys = (row: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(row).sort().join("\0") === [...keys].sort().join("\0");
  const validIssuer = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search
        && !parsed.hash && parsed.href === value;
    } catch { return false; }
  };
  if (!source || !Array.isArray(source.subjects) || !Array.isArray(source.clients)
    || !Array.isArray(source.adminUsers) || !Array.isArray(source.revokeAudit)
    || !Array.isArray(source.erasures) || !Array.isArray(source.lifecycleEvents)
    || typeof source.sourceId !== "string" || !source.sourceId || source.sourceId.length > 1024
    || !validIssuer(source.issuer)
    || !source.observation || Object.values(source.observation).some(value => typeof value !== "string" || !value)) fail("invalid_input");
  const binding = new Map<string, { managedId: string; issuer: string; subject: string; principalId: string }>();
  const principalIds = new Set<string>();
  for (const value of source.subjects) {
    if (!validRow(value) || typeof value.managedId !== "string" || !uuid.test(value.managedId)
      || typeof value.subject !== "string" || !value.subject
      || value.subject.length > 1024 || Array.from(String(value.subject)).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || binding.has(value.managedId.toLowerCase())) fail("invalid_input");
    const principalId = deriveOidcPrincipalId(source.issuer, value.subject);
    if (principalIds.has(principalId)) fail("target_conflict", "platform_human_principals");
    principalIds.add(principalId);
    binding.set(value.managedId.toLowerCase(), { managedId: value.managedId.toLowerCase(), issuer: source.issuer,
      subject: value.subject, principalId });
  }
  const mapped = (id: unknown): string => {
    if (typeof id !== "string" || !uuid.test(id)) fail("invalid_input");
    const result = binding.get(id.toLowerCase());
    if (!result) fail("invalid_input");
    return result.principalId;
  };
  const nullable = (id: unknown): string | null => id === null ? null : mapped(id);
  const clients: Record<string, unknown>[] = [];
  const clientIds = new Set<string>();
  const linkedPrincipals = new Set<string>();
  for (const row of source.clients) {
    if (!validRow(row) || typeof row.id !== "string" || !uuid.test(row.id) || clientIds.has(row.id.toLowerCase())
      || !onlyKeys(row, ["id", "created_at", "updated_at", "email", "first_name", "last_name", "phone", "country",
        "lifecycle_stage", "acquisition_source", "external_ref", "metadata", "preferences", "auth_user_id", "identity_kind", "marketing_contact_id"])
      || row.identity_kind !== "customer" || row.marketing_contact_id !== null
      || !validRow(row.preferences) || Object.keys(row.preferences).length !== 0) fail("invalid_input");
    clientIds.add(row.id.toLowerCase());
    const mappedRow: Record<string, unknown> = {};
    for (const column of packet.compatible.tables.find(table => table.table === "clients")!.columns) {
      mappedRow[column.name] = column.name === "principal_id" ? nullable(row.auth_user_id) : row[column.name];
      if (mappedRow[column.name] === undefined) fail("invalid_input");
    }
    if (mappedRow.principal_id !== null) {
      const principalId = String(mappedRow.principal_id);
      if (linkedPrincipals.has(principalId)) fail("target_conflict", "clients");
      linkedPrincipals.add(principalId);
    }
    clients.push(mappedRow);
  }
  const principals: Record<string, unknown>[] = [], memberships: Record<string, unknown>[] = [];
  const operatorIds = new Set<string>();
  for (const row of source.adminUsers) {
    if (!validRow(row) || typeof row.id !== "string" || !uuid.test(row.id) || operatorIds.has(row.id.toLowerCase())
      || !onlyKeys(row, ["id", "email", "created_at", "role", "is_machine_actor", "membership_state", "membership_provenance",
        "membership_accepted_at", "membership_revoked_at", "membership_revoked_by", "membership_revocation_reason"])
      || row.is_machine_actor !== false || typeof row.email !== "string" || !row.email) fail("invalid_input");
    operatorIds.add(row.id.toLowerCase());
    const principalId = mapped(row.id);
    principals.push({ principal_id: principalId, email: row.email, created_at: row.created_at });
    memberships.push({ principal_id: principalId, role: row.role, membership_state: row.membership_state,
      membership_provenance: row.membership_provenance, membership_accepted_at: row.membership_accepted_at,
      membership_revoked_at: row.membership_revoked_at, membership_revoked_by: nullable(row.membership_revoked_by),
      membership_revocation_reason: row.membership_revocation_reason });
  }
  const audit: Record<string, unknown>[] = [];
  const auditReferences: ManagedIdentityMappingResult["auditReferences"][number][] = [];
  const auditedTargets = new Set<string>();
  for (const row of source.revokeAudit) {
    if (!validRow(row) || row.action !== "revoke" || typeof row.id !== "string" || !uuid.test(row.id)
      || typeof row.actor_admin_id !== "string"
      || !onlyKeys(row, ["id", "actor_admin_id", "actor_email", "actor_kind", "action", "source", "entity_type",
        "entity_id", "target_admin_id", "target_email", "old_value", "new_value", "occurred_at", "idempotency_key", "request_id"])
      || typeof row.target_admin_id !== "string" || !operatorIds.has(row.actor_admin_id.toLowerCase())
      || !operatorIds.has(row.target_admin_id.toLowerCase()) || !validRow(row.old_value) || !validRow(row.new_value)) fail("invalid_input");
    const targetId = row.target_admin_id.toLowerCase();
    const target = source.adminUsers.find(value => value.id === targetId || String(value.id).toLowerCase() === targetId)!;
    const oldValue = row.old_value, newValue = row.new_value;
    if (auditedTargets.has(targetId) || row.actor_kind !== "human" || row.entity_type !== "admin_user_membership"
      || row.entity_id !== row.target_admin_id || target.membership_state !== "revoked"
      || !onlyKeys(oldValue, ["membershipState", "role"])
      || !onlyKeys(newValue, Object.hasOwn(newValue, "revocationReason")
        ? ["membershipState", "revokedAt", "revokedBy", "revocationReason"] : ["membershipState", "revokedAt", "revokedBy"])
      || oldValue.membershipState !== "active" || oldValue.role !== target.role
      || newValue.membershipState !== "revoked" || newValue.revokedAt !== target.membership_revoked_at
      || typeof target.membership_revoked_by !== "string"
      || target.membership_revoked_by.toLowerCase() !== row.actor_admin_id.toLowerCase()
      || newValue.revokedBy !== row.actor_admin_id || (newValue.revocationReason ?? null) !== target.membership_revocation_reason) {
      fail("target_conflict", "platform_human_membership_audit_events");
    }
    auditedTargets.add(targetId);
    auditReferences.push({ sourceId: source.sourceId, sourceRowId: row.id, targetAuditId: row.id });
    audit.push({ id: row.id, actor_principal_id: mapped(row.actor_admin_id),
      target_principal_id: mapped(row.target_admin_id), action: "revoke", old_value: oldValue,
      new_value: { ...newValue, revokedBy: mapped(row.actor_admin_id), sourceAuditRef: { sourceId: source.sourceId, rowId: row.id } },
      reason: newValue.revocationReason ?? null, occurred_at: row.occurred_at });
  }
  if (source.adminUsers.some(row => row.membership_state === "revoked" && !auditedTargets.has(String(row.id).toLowerCase()))) {
    fail("invalid_input");
  }
  const erasures: Record<string, unknown>[] = [];
  const erasedClientIds = new Set<string>();
  const erasedPrincipalIds = new Set<string>();
  for (const row of source.erasures) {
    if (!validRow(row) || row.contract_version !== "identity.erasure.v1"
      || !onlyKeys(row, ["erasure_id", "idempotency_key", "client_id", "principal_id", "actor_principal_id",
        "contract_version", "contributor_versions", "dispositions", "retained_obligations", "completed_at"])
      || row.client_id !== null && (typeof row.client_id !== "string" || !clientIds.has(row.client_id.toLowerCase()))
      || typeof row.actor_principal_id !== "string" || !operatorIds.has(row.actor_principal_id.toLowerCase())) fail("invalid_input");
    if (typeof row.client_id === "string") erasedClientIds.add(row.client_id.toLowerCase());
    if (row.principal_id !== null) erasedPrincipalIds.add(mapped(row.principal_id));
    erasures.push({ erasure_id: row.erasure_id, idempotency_key: row.idempotency_key,
      client_id: row.client_id, principal_id: nullable(row.principal_id),
      actor_principal_id: mapped(row.actor_principal_id), contract_version: row.contract_version,
      contributor_versions: row.contributor_versions, dispositions: row.dispositions,
      retained_obligations: row.retained_obligations, completed_at: row.completed_at });
  }
  for (const row of source.clients) {
    if (typeof row.email !== "string" || !row.email) fail("invalid_input");
    if (row.email.startsWith("erased+")) {
      if (!row.email.endsWith("@identity.invalid") || !erasedClientIds.has(String(row.id).toLowerCase()) || row.auth_user_id !== null
        || row.first_name !== null || row.last_name !== null || row.phone !== null || row.country !== null) fail("invalid_input");
    } else if (erasedClientIds.has(String(row.id).toLowerCase())) fail("invalid_input");
  }
  for (const row of source.adminUsers) {
    const erased = erasedPrincipalIds.has(mapped(row.id));
    const redacted = typeof row.email === "string" && row.email.startsWith("erased+")
      && row.email.endsWith("@identity.invalid");
    if (erased ? !redacted || row.membership_state !== "revoked" || row.membership_revocation_reason !== null
      : redacted) fail("invalid_input");
  }
  if (clients.some(row => row.principal_id !== null && erasedPrincipalIds.has(String(row.principal_id)))) fail("invalid_input");
  const lifecycle = source.lifecycleEvents.map(row => {
    if (!validRow(row) || typeof row.client_id !== "string" || !clientIds.has(row.client_id.toLowerCase())) fail("invalid_input");
    return row;
  });
  const replacements = new Map<string, Record<string, unknown>[]>([
    ["clients", clients], ["platform_human_principals", principals], ["platform_human_memberships", memberships],
    ["platform_human_membership_audit_events", audit], ["identity_privacy_erasures", erasures],
    ["customer_subject_lifecycle_events", lifecycle],
  ]);
  for (const [table, values] of replacements) {
    await replaceTargetRows(packet, table, values, input.targetOwner, {
      quoteIdentifier: quoteRestoreIdentifier,
      columnMismatchCode: "invalid_input",
    });
  }
  packet.compatible.sourceId = source.sourceId;
  packet.observation = source.observation;
  rehashCapturePacket(packet);
  return { packet, subjects: [...binding.values()], auditReferences };
}
