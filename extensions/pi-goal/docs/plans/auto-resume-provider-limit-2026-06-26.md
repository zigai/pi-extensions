# Auto-Resume Provider Usage Limits: Plan

## Goal

Implement issue [#43](https://github.com/fitchmultz/pi-codex-goal/issues/43): when a goal pauses because a recognized provider usage-limit/quota error is hit, pi-codex-goal should retry resume automatically after a conservative fixed delay instead of requiring the user to type `/goal resume`.

User decisions already made:

- Scope only recognized provider usage-limit/quota errors.
- Default auto-resume on for those pauses.
- Provide a stop/cancel path.
- Use one conservative fixed retry delay; skip user config for now.

## Background

Provider errors are handled at `agent_end`, not `turn_end`: `src/goal-runtime-turn-handlers.ts:54`, `src/goal-runtime-agent-handlers.ts:32`, `src/goal-runtime-event-utils.ts:84`. Today, non-retryable provider-limit/billing errors become a `pause` recovery action (`src/recovery.ts:73`, `src/recovery-machine.ts:164`) and the pause transition sets the goal to `paused`, clears continuation state, and shows `/goal resume` guidance (`src/recovery-runtime.ts:46`, `src/goal-transition.ts:321`, `src/recovery.ts:147`, `src/format.ts:143`).

Manual `/goal resume` already does the important work: it changes a paused goal back to active and queues `compactContinuationPrompt` as a user follow-up (`src/commands.ts:94`, `src/commands.ts:114`, `src/goal-state-controller.ts:169`). Existing continuation scheduling is not enough because it only runs for active goals (`src/continuation-scheduler.ts:112`).

There is no in-repo plan or prior implementation for provider-limit reset polling. Relevant prior behavior: `CHANGELOG.md:151` made quota/billing/provider-limit errors terminal instead of host-retry pending, and `CHANGELOG.md:161` stopped provider-error hidden-continuation retry storms.

## Approach

Add the smallest runtime-only auto-resume path:

1. Keep provider-limit errors classified as non-retryable pauses.
2. In `handlePersistentAssistantError`, detect whether the assistant error is a provider-limit error before calling `planRecoveryForAssistantError`.
3. Apply the existing pause action unchanged.
4. If the action was `pause` and the current goal is now the same paused goal, schedule one cancellable timer.
5. When the timer fires, re-check the current goal id and status.
6. If it is still the same paused goal, reuse the same resume outcome as `/goal resume`: `resume_active` plus `compactContinuationPrompt` as a user follow-up.
7. If the provider is still capped, the resumed turn will fail again and the normal `agent_end -> recovery_pause` path will schedule the next fixed-delay retry.

Do not add provider API polling, persistence, exponential backoff, user config, or a new `RecoveryAction` variant. The provider exposes no reset signal here, so the correct small model is a fixed re-attempt with stale-timer guards.

## Work Items

1. **Expose provider-limit classification**
   - In `src/recovery.ts`, export `isProviderLimitError(errorMessage: string | undefined): boolean`.
   - Have the current private provider-limit check delegate to it.
   - Add the issue wording: `usage limit has been reached`.
   - Test in `test/recovery.test.ts` with existing quota strings, the Codex issue string, and generic non-retryable errors.

2. **Add a fixed retry delay**
   - Add `PROVIDER_LIMIT_AUTO_RESUME_MS` to `src/runtime-config.ts`.
   - Use `5 * 60_000` as the first value.
   - Do not add config until real use shows the constant is wrong.

3. **Add a small scheduler**
   - Create `src/provider-limit-auto-resume.ts`.
   - Mirror the cancellable timer shape in `src/continuation-scheduler.ts:28` and `src/continuation-scheduler.ts:123`.
   - Track the scheduled goal id and a generation/token so stale timer callbacks no-op.
   - Expose only `schedule(goalId)`, `clear()`, and `isScheduledFor(goalId)`.
   - Call `unref()` when available.

4. **Create one shared resume helper**
   - Wire it in `src/goal-runtime-controller.ts` as `resumeGoalWithContinuation(goalId, source, ctx)`.
   - It should read the current goal, require the same paused goal id, clear any provider-limit auto-resume timer, call `resumePausedGoal`, then queue the same compact user follow-up as manual `/goal resume`.
   - Add this method to the command host shape and use it from `src/commands.ts`.
   - Do not expose scheduler internals to commands, and do not route auto-resume through the command parser.

5. **Schedule only provider-limit pauses**
   - Inject the scheduler into `src/recovery-runtime.ts`.
   - In `handlePersistentAssistantError`, compute `isProviderLimitError(message.errorMessage)` before planning recovery.
   - After applying the planned action, schedule only if the planned action was `pause`, the error was a recognized provider limit, and the current goal is now paused.
   - Do not schedule for context overflow, malformed tool responses, aborts, generic non-retryable errors, or transient pending recovery.

6. **Add a cancel command**
   - In `src/commands.ts`, handle `resume cancel` before the single-word `resume` branch.
   - Clear the pending provider-limit auto-resume timer for the current goal through the command host.
   - Leave the goal paused.
   - Notify: `Provider-limit auto-resume canceled. Use /goal resume when ready.`
   - Add a small completion/help update only if cheap; parsing is the required behavior.

7. **Clear stale timers from controller-owned invalidation paths**
   - Clear the scheduler in the shared resume helper, `clearGoal`, `setGoal` when replacing/changing the current paused goal, `completeGoal`, `session_shutdown`, and ordinary user input.
   - Do not add a new transition effect unless implementation shows a direct state-controller path can leave a stale timer behind.
   - This keeps cleanup centralized without widening the transition type surface.

8. **Update footer copy with scheduler state**
   - Keep generic paused attention copy for non-provider-limit pauses.
   - Make runtime status formatting aware of `isScheduledFor(goal.goalId)` rather than encoding timer state into the recovery reason.
   - For scheduled provider-limit pauses, show: `Goal paused because the provider usage limit was reached. Auto-resume will retry in about 5 minutes. Use /goal resume to resume now or /goal resume cancel to stop auto-resume.`
   - Avoid live countdowns and persisted timer state.
   - After restart, it is acceptable to fall back to the existing manual `/goal resume` path.

9. **Test the behavior end to end**
   - Provider-limit pause schedules a timer.
   - Non-limit non-retryable pause does not schedule.
   - Timer fire resumes the paused goal and queues a compact user continuation.
   - Manual `/goal resume` clears the timer and queues the same continuation.
   - `/goal resume cancel` clears the timer and leaves the goal paused.
   - Ordinary user input and session shutdown clear the timer.
   - A second provider-limit failure after auto-resume schedules one new timer, proving there is no immediate retry storm.
   - Extend `test/support/runtime-harness.ts` with a small fire helper so tests do not wait five minutes.

10. **Verify**
    - Run `npm run verify`.

## Open Questions

None. The plan intentionally chooses the small runtime-only path: fixed delay, no persistence, no config, no provider polling, no new recovery action variant.

## References

- Issue: https://github.com/fitchmultz/pi-codex-goal/issues/43
- Error classification: `src/recovery.ts:73`, `test/recovery.test.ts:115`
- Provider-error runtime path: `src/goal-runtime-agent-handlers.ts:32`, `src/goal-runtime-event-utils.ts:84`, `src/recovery-runtime.ts:46`
- Pause/resume transitions: `src/goal-transition.ts:318`, `src/goal-transition.ts:321`
- Manual resume command: `src/commands.ts:94`, `src/commands.ts:114`
- Timer precedent: `src/continuation-scheduler.ts:28`, `src/continuation-scheduler.ts:123`, `src/goal-runtime-session-handlers.ts:35`
- Prior behavior notes: `CHANGELOG.md:151`, `CHANGELOG.md:161`
