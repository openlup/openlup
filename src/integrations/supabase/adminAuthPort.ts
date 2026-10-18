/** Load the managed browser SDK/client only after managed selection. */
export function loadManagedAdminAuth() {
  return import('./client');
}
