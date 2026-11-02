export type AgentReason =
  | "actor_required"
  | "actor_unknown"
  | "actor_kind_not_allowed"
  | "publish_requires_human"
  | "draft_only_for_machine"
  | "price_required_to_sell"
  | "not_found"
  | "already_exists"
  | "feature_flag_disabled"
  | (string & {});
