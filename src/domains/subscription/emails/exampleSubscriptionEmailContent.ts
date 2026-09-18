import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import { exampleSubscriptionDunningEmailContent } from "./exampleSubscriptionDunningEmailContent.js";
import { exampleSubscriptionLifecycleEmailContent } from "./exampleSubscriptionLifecycleEmailContent.js";

export const subscriptionEmailContent = Object.freeze({
  id: "example",
  ...exampleSubscriptionLifecycleEmailContent,
  ...exampleSubscriptionDunningEmailContent,
} satisfies SubscriptionEmailContent);
