The user explicitly requested a new long-running goal from this task:

<untrusted_task>
{{task}}
</untrusted_task>

Requested goal constraints (user-configured data):
<untrusted_goal_constraints>
{{constraints}}
</untrusted_goal_constraints>

Current thread goal:
<untrusted_current_goal>
{{currentGoal}}
</untrusted_current_goal>

Turn the task into exactly one durable pi-codex-goal objective, then call `create_goal` with that objective and `replace_existing: true`.

The goal must be a completion contract, not a task summary. Preserve the user's full intent and explicit acceptance criteria without inventing unrelated work.

The goal must require:

1. Outcome
   - State what must be true when complete.
   - Preserve the full requested end state.
   - Do not narrow scope after the fact unless the original task explicitly defined that scope.

2. Verification evidence
   - Name the concrete evidence required before completion.
   - Include relevant tests, lint, type checks, builds, smoke checks, diffs, docs, generated outputs, rendered UI inspection, or artifact checks when applicable.
   - If the repository has an existing local CI or validation command, require it unless clearly irrelevant.

3. Constraints and boundaries
   - Preserve the user's stated constraints and relevant existing behavior.
   - State what may change, what must not change, and which actions still require approval.
   - Do not discard user changes or treat the goal as broader authority than the original request.

4. Iteration policy
   - After each attempt, inspect evidence and take the next low-risk useful step.
   - Do not stop at a plan when implementation or verification remains.
   - If validation fails, triage the cause rather than treating partial progress as completion.

5. Completion audit
   - Before marking the goal complete, map every explicit requirement to fresh evidence from files, commands, diffs, tests, screenshots, artifacts, or logs.
   - The goal is not complete if any requirement is unverified, narrowed, deferred, or only probably satisfied.

6. Blocked stop condition
   - If no safe in-scope path remains without unavailable input, authority, access, or dependencies, call `update_goal` with status `blocked` instead of marking complete.
   - Report attempted paths, exact blockers, remaining requirements, and what would unblock progress.

Use concise imperative language in the goal. If the task is blank or only whitespace, ask the user to clarify.
