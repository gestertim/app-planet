import {
  accessContextSchema,
  capabilitySchema,
  roleSchema,
  type AccessDecision,
} from "../contracts/common.ts";

const denied = (code: Exclude<AccessDecision, { allowed: true }>["code"]): AccessDecision => ({
  allowed: false,
  code,
});

export function decideCapability(
  input: unknown,
  capabilityInput: unknown,
): AccessDecision {
  const contextResult = accessContextSchema.safeParse(input);
  const capabilityResult = capabilitySchema.safeParse(capabilityInput);

  if (!contextResult.success || !capabilityResult.success) {
    return denied("invalid_input");
  }

  const context = contextResult.data;
  const capability = capabilityResult.data;

  if (context.deletionState !== "none" || context.accountStatus === "disabled") {
    return denied("account_unavailable");
  }

  if (capability === "login") {
    if (
      context.role !== "student" &&
      (context.accountStatus === "pending" || context.accountStatus === "rejected")
    ) {
      return { allowed: true, code: "allowed" };
    }

    if (context.accountStatus !== "approved") {
      return denied("account_unavailable");
    }

    if (context.role === "student" && context.schoolApproval === "unconfirmed") {
      return denied("school_not_confirmed");
    }

    return { allowed: true, code: "allowed" };
  }

  if (context.accountStatus !== "approved") {
    return denied("account_unavailable");
  }

  if (context.role === "student" && context.schoolApproval === "unconfirmed") {
    return denied("school_not_confirmed");
  }

  if (context.role !== "student") {
    return denied("role_not_authorized");
  }

  if (capability === "ai_call") {
    if (context.schoolApproval !== "approved") {
      return denied("ai_not_open");
    }
    if (!context.aiOnDuty) {
      return denied("ai_off_duty");
    }
  }

  if (capability === "public_deploy" && context.schoolApproval !== "approved") {
    return denied("public_deploy_paused");
  }

  return { allowed: true, code: "allowed" };
}

export function canAccessRoleHome(input: unknown, requiredRole: unknown): boolean {
  const contextResult = accessContextSchema.safeParse(input);
  const roleResult = roleSchema.safeParse(requiredRole);

  if (!contextResult.success || !roleResult.success) {
    return false;
  }

  return (
    contextResult.data.role === roleResult.data &&
    contextResult.data.accountStatus === "approved" &&
    decideCapability(contextResult.data, "login").allowed
  );
}
