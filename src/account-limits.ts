import type { Query, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { parseUsageResponse } from "./usage-markdown.js";
import type { Logger } from "./acp-agent.js";
import { raceTimeoutAndAbort } from "./utils.js";

/** `_meta` key of a `usage_update` that carries {@link AccountLimits}. */
export const ACCOUNT_LIMITS_META_KEY = "_claude/accountLimits";

const ACCOUNT_LIMITS_TIMEOUT_MS = 5_000;

export type AccountLimitWindow = {
  type: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "seven_day_model";
  /** Display name of the model a `seven_day_model` window meters. */
  model?: string;
  /** Percentage of the window used, 0-100. */
  utilization: number;
  /** ISO 8601 timestamp when the window resets. */
  resetsAt: string | null;
};

/** The subscription's plan rate-limit windows. This shape is the adapter's own
 *  contract: it stays stable while the experimental SDK response it is read
 *  from changes. */
export type AccountLimits = {
  subscriptionType: string | null;
  windows: AccountLimitWindow[];
};

/** Null when plan rate limits do not apply (API key, Bedrock, Vertex). */
export function accountLimitsFromUsage(usage: SDKControlGetUsageResponse): AccountLimits | null {
  const limits = usage.rate_limits;
  if (!usage.rate_limits_available || !limits) return null;
  const windows: AccountLimitWindow[] = [];
  const add = (
    type: AccountLimitWindow["type"],
    window: { utilization: number | null; resets_at: string | null } | null | undefined,
    model?: string,
  ) => {
    if (!window || window.utilization === null) return;
    windows.push({
      type,
      ...(model !== undefined && { model }),
      utilization: window.utilization,
      resetsAt: window.resets_at,
    });
  };
  add("five_hour", limits.five_hour);
  add("seven_day", limits.seven_day);
  add("seven_day_opus", limits.seven_day_opus);
  add("seven_day_sonnet", limits.seven_day_sonnet);
  for (const scoped of limits.model_scoped ?? []) {
    add("seven_day_model", scoped, scoped.display_name);
  }
  return { subscriptionType: usage.subscription_type, windows };
}

/** Best-effort reading of the plan windows. Null covers every reason there is
 *  nothing to publish, so a caller never fails a turn over account limits. */
export async function readAccountLimits(
  query: Query,
  signal: AbortSignal,
  logger: Logger,
): Promise<AccountLimits | null> {
  if (signal.aborted) return null;
  // Older or stubbed queries have no usage control request; that is not an error.
  if (typeof query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") {
    return null;
  }
  try {
    const outcome = await raceTimeoutAndAbort(
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      ACCOUNT_LIMITS_TIMEOUT_MS,
      signal,
    );
    if (outcome.type !== "done") {
      if (outcome.type === "timeout") logger.error("Account limits read timed out");
      return null;
    }
    const usage = parseUsageResponse(outcome.value);
    if (!usage) {
      logger.error("Account limits read returned an incompatible response");
      return null;
    }
    return accountLimitsFromUsage(usage);
  } catch (error) {
    logger.error(`Account limits read failed: ${error}`);
    return null;
  }
}
