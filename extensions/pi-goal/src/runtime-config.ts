export const CONTINUATION_RETRY_MS = 50;
export const PROVIDER_LIMIT_AUTO_RESUME_MS = 5 * 60_000;
export const RUNTIME_PERSIST_INTERVAL_MS = 60_000;
/**
 * Trigger a mid-run compaction when estimated context usage is within this
 * many tokens of the context window. Kept above the pi host's default
 * compaction reserve (30k) so the extension fires before the hard overflow.
 */
export const PROACTIVE_COMPACTION_RESERVE_TOKENS = 50_000;

export const __testHooks = {
  continuationRetryMs: CONTINUATION_RETRY_MS,
  providerLimitAutoResumeMs: PROVIDER_LIMIT_AUTO_RESUME_MS,
  runtimePersistIntervalMs: RUNTIME_PERSIST_INTERVAL_MS,
  proactiveCompactionReserveTokens: PROACTIVE_COMPACTION_RESERVE_TOKENS,
};
