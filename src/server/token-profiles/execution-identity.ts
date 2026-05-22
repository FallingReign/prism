import "server-only";

import type { MethodCategory } from "../slack/method-registry";
import type { SlackMethodPolicyDecision, SlackPolicyBody } from "./method-policy";

type AllowedPolicyDecision = Extract<SlackMethodPolicyDecision, { kind: "allowed" }>;

export type ConcreteExecutionMode = "user" | "bot";
export type RequestedExecutionMode = ConcreteExecutionMode | "auto" | null;

export type SlackExecutionIdentityDecision =
  | {
      kind: "resolved";
      tokenProfileId: string;
      slackConnectionId?: string | null;
      executionMode: ConcreteExecutionMode;
      requestedMode: RequestedExecutionMode;
    }
  | { kind: "denied"; httpStatus: number; body: SlackPolicyBody };

export function resolveSlackExecutionIdentity({
  decision,
  executionModeHeader,
  requestId
}: {
  decision: AllowedPolicyDecision;
  executionModeHeader: string | null;
  requestId: string;
}): SlackExecutionIdentityDecision {
  const requestedMode = parseExecutionMode(executionModeHeader);
  if (requestedMode === "invalid") return denied(decision, requestId, "invalid_execution_mode", null);

  if (requestedMode && decision.capabilityMap.executionIdentity !== "selectable") {
    return denied(decision, requestId, "execution_mode_not_selectable", requestedMode);
  }

  const executionMode = chooseExecutionMode(decision, requestedMode);
  if (!decision.executionIdentity.modes[executionMode]) {
    return denied(decision, requestId, "execution_identity_unavailable", requestedMode, {
      unavailableReason: executionMode === "user" ? "missing_user_identity" : "missing_bot_identity"
    });
  }

  return {
    kind: "resolved",
    tokenProfileId: decision.tokenProfileId,
    slackConnectionId: decision.slackConnectionId,
    executionMode,
    requestedMode
  };
}

function parseExecutionMode(value: string | null): RequestedExecutionMode | "invalid" {
  if (value === null || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "user" || normalized === "bot" || normalized === "auto") return normalized;
  return "invalid";
}

function chooseExecutionMode(decision: AllowedPolicyDecision, requestedMode: RequestedExecutionMode): ConcreteExecutionMode {
  if (requestedMode === "user" || requestedMode === "bot") return requestedMode;
  if (decision.capabilityMap.executionIdentity === "user") return "user";
  if (decision.capabilityMap.executionIdentity === "bot") return "bot";
  return chooseAutomaticMode(decision.category, decision.executionIdentity.modes);
}

function chooseAutomaticMode(category: MethodCategory, modes: AllowedPolicyDecision["executionIdentity"]["modes"]): ConcreteExecutionMode {
  const preferred: ConcreteExecutionMode = ["messages.write", "messages.destructive", "reactions"].includes(category) ? "bot" : "user";
  const fallback: ConcreteExecutionMode = preferred === "bot" ? "user" : "bot";
  return modes[preferred] ? preferred : fallback;
}

function denied(
  decision: AllowedPolicyDecision,
  requestId: string,
  errorClass: string,
  requestedMode: RequestedExecutionMode,
  extra: { unavailableReason?: string } = {}
): SlackExecutionIdentityDecision {
  return {
    kind: "denied",
    httpStatus: 200,
    body: {
      ok: false,
      error: "not_allowed",
      prism: {
        requestId,
        errorClass,
        method: decision.method,
        category: decision.category,
        tokenProfileId: decision.tokenProfileId,
        requiredCapability: requestedMode ? `execution:${requestedMode}` : undefined,
        unavailableReason: extra.unavailableReason,
        mutation: decision.mutation
      }
    }
  };
}
