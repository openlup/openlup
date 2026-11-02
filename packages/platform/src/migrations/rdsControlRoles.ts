// Fixed stock inventory shared by RDS edge admission and recipe freshness.
export const rdsControlRoles: readonly string[] = Object.freeze([
  "rds_ad", "rds_extension", "rds_iam", "rds_password", "rds_replication",
  "rds_reserved", "rds_superuser", "rdsadmin",
]);
export const rdsAuthorityRoles: readonly string[] = Object.freeze(["rds_superuser"]);
