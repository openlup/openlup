import { PrivacyRefusal, type PersonalDataContributor, type PersonalDataContributorRegistry } from "./privacyPorts.js";
export function createPersonalDataContributorRegistry<Context>(contributors: readonly PersonalDataContributor<Context>[], options: { requiredContributorIds: readonly string[] }): PersonalDataContributorRegistry<Context> {
  const ids = contributors.map(c => c.id);
  if (new Set(ids).size !== ids.length) throw new PrivacyRefusal("PRIVACY_CONTRIBUTOR_DUPLICATE");
  if (contributors.some(c => !/^[a-z][a-z0-9.-]{0,99}$/.test(c.id) || !/^[a-z][a-z0-9.-]*\.v[1-9][0-9]*$/.test(c.version))) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
  if (contributors.some(c => !Array.isArray(c.ownedResources) || c.ownedResources.length === 0 || c.ownedResources.some(resource => !resource.trim()))) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
  return Object.freeze({ contributors: Object.freeze([...contributors]), missingContributors: Object.freeze(options.requiredContributorIds.filter(id => !ids.includes(id))) });
}
