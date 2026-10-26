import { schemaObjectKey, type RequiredSchema } from "@openlup/core/readiness";

/** Requirements come from the selected owners, including exact overloads.
 * Command-only M10 hosts supply preview AND apply; the renewal runner is separate.
 */
export function m12AccountSupportSchema(input: {
  catalogue: { version: string; migration: string };
  owners: readonly RequiredSchema[];
  requiredObjects: RequiredSchema["objects"];
}): RequiredSchema {
  const objects = new Map<string, RequiredSchema["objects"][number]>();
  for (const object of [...input.owners.flatMap(owner => owner.objects), ...input.requiredObjects]) {
    objects.set(schemaObjectKey(object), { ...object });
  }
  return { ...input.catalogue, objects: [...objects.values()] };
}
