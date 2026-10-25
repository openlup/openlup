import type { SubscriptionCommand, SubscriptionCommandContext, SubscriptionCommandPort } from "./contracts/commands.js";

/** Neutral examples. The host authenticates and authorizes actor/client ownership first. */
export function createSubscriptionCommandExamples(commands: SubscriptionCommandPort) {
  const apply = (context: SubscriptionCommandContext, command: SubscriptionCommand) => {
    if (context.actor.actorId.trim() === "" || context.actor.clientId.trim() === "") throw new Error("subscription_command_actor_required");
    return commands.apply(command);
  };
  return {
    customerSkip(context: SubscriptionCommandContext) {
      if (context.actor.kind !== "customer") throw new Error("subscription_command_customer_required");
      return apply(context, { ...context, action: "skip", reason: null, confirmedChargeTiming: true });
    },
    operatorSlide(context: SubscriptionCommandContext, newNextCycleAt: string) {
      if (context.actor.kind !== "operator") throw new Error("subscription_command_operator_required");
      return apply(context, { ...context, action: "slide", newNextCycleAt, confirmedChargeTiming: true });
    },
  };
}
