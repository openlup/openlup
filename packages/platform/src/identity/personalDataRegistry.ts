import { PrivacyRefusal, type PersonalDataContributor, type PersonalDataContributorRegistry } from "./privacyPorts.js";
import { privacyContributorId, privacyContributorVersion } from "./requiredPrivacyContributors.js";
export function createPersonalDataContributorRegistry<Context>(contributors: readonly PersonalDataContributor<Context>[], options: { requiredContributorIds: readonly string[] }): PersonalDataContributorRegistry<Context> {
  const ids = contributors.map(c => c.id);
  if (new Set(ids).size !== ids.length) throw new PrivacyRefusal("PRIVACY_CONTRIBUTOR_DUPLICATE");
  if (contributors.some(c => !privacyContributorId.test(c.id) || !privacyContributorVersion.test(c.version))) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
  if (contributors.some(c => !Array.isArray(c.ownedResources) || c.ownedResources.length === 0 || c.ownedResources.some(resource => !resource.trim()))) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
  return Object.freeze({ contributors: Object.freeze([...contributors]), missingContributors: Object.freeze(options.requiredContributorIds.filter(id => !ids.includes(id))) });
}
