import { runRemoveAdminUserUseCase as run, identityMessages } from "@openlup/platform/identity";
export type { RemoveAdminUserResponse, RemoveAdminUserGateway } from "@openlup/platform/identity";
export async function runRemoveAdminUserUseCase(request: Parameters<typeof run>[0], gateway: Parameters<typeof run>[1]) {
  const result = await run(request, gateway, identityMessages.pl);
  const { code: _code, ...body } = result.body;
  return { ...result, body };
}
