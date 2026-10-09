import { createAccountingState, type AccountingState } from "./goal-accounting.ts";
import { createGoalRecoveryMachine, type GoalRecoveryMachineState } from "./recovery-machine.ts";
import {
  createStaleQueuedWorkGuard,
  type StaleQueuedWorkGuard,
} from "./stale-queued-work-guard.ts";

export interface GoalRuntimeState {
  accounting: AccountingState;
  recoveryState: GoalRecoveryMachineState;
  agentRunSequence: number;
  currentTurnIndex: number | null;
  staleQueuedWorkGuard: StaleQueuedWorkGuard;
}

export function createGoalRuntimeState(): GoalRuntimeState {
  return {
    accounting: createAccountingState(),
    recoveryState: createGoalRecoveryMachine(),
    agentRunSequence: 0,
    currentTurnIndex: null,
    staleQueuedWorkGuard: createStaleQueuedWorkGuard(),
  };
}
