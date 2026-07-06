import type { ContextUsage } from "@earendil-works/pi-coding-agent";

/**
 * True when estimated context usage is close enough to the context window that
 * a mid-run compaction should be triggered before the next provider request.
 *
 * The pi host only evaluates its compaction threshold at agent-run boundaries,
 * so a long autonomous run can grow past the context window mid-run and die on
 * a hard overflow error. This predicate backs the extension-side turn_end check
 * that closes that gap for active goal runs.
 */
export function proactiveCompactionDue(
  usage: ContextUsage | undefined,
  reserveTokens: number,
): boolean {
  if (!usage || usage.tokens === null) {
    return false;
  }
  if (usage.contextWindow <= reserveTokens) {
    return false;
  }
  return usage.tokens > usage.contextWindow - reserveTokens;
}
