import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import {
    commandSchema,
    outputSchema,
    waitOutputSchema,
    type CommandOutput,
    type CommandSnapshot,
} from "./commands.ts";

type Listener = () => void;

export const RESULT_MESSAGE_TYPE = "pi-background.result";

const commandValidator = Compile(commandSchema);
const outputValidator = Compile(outputSchema);
const waitOutputValidator = Compile(waitOutputSchema);

/**
 * Finished job results by job ID, so the row that started a job can show how it ended.
 * Rows ask for a job's outcome when they render and are invalidated once it arrives.
 */
export class JobOutcomes {
    private readonly outcomes = new Map<string, CommandOutput>();
    private readonly running = new Set<string>();
    private readonly listeners = new Map<string, Set<Listener>>();

    get(id: string): CommandOutput | undefined {
        return this.outcomes.get(id);
    }

    /** True while this session runs the job; restored jobs ended with their session. */
    isRunning(id: string): boolean {
        return this.running.has(id);
    }

    started(job: CommandSnapshot): void {
        if (job.state === "running") this.running.add(job.id);
    }

    record(result: CommandOutput): void {
        if (result.job.state === "running") return;

        const previous = this.outcomes.get(result.job.id);
        if (previous !== undefined && previous.output.length >= result.output.length) return;

        this.running.delete(result.job.id);
        this.outcomes.set(result.job.id, result);

        const listeners = this.listeners.get(result.job.id);
        this.listeners.delete(result.job.id);

        for (const listener of listeners ?? []) listener();
    }

    /** Calls listener once when the job's outcome arrives. */
    watch(id: string, listener: Listener): void {
        if (this.outcomes.has(id)) return;

        const listeners = this.listeners.get(id) ?? new Set();
        listeners.add(listener);
        this.listeners.set(id, listeners);
    }

    /** Records every finished job reported in a saved session, for resumed sessions. */
    restore(entries: readonly SessionEntry[]): void {
        for (const entry of entries) {
            if (entry.type === "custom_message" && entry.customType === RESULT_MESSAGE_TYPE) {
                if (outputValidator.Check(entry.details)) this.record(entry.details);
                continue;
            }

            if (entry.type !== "message" || entry.message.role !== "toolResult") continue;

            const { toolName, details } = entry.message;
            if (toolName === "background_wait" && waitOutputValidator.Check(details))
                for (const result of details.jobs) this.record(result);

            if (toolName === "background_status" && outputValidator.Check(details))
                this.record(details);

            if (toolName === "background_stop" && commandValidator.Check(details))
                this.record({ job: details, output: "", truncated: false });
        }
    }

    /** Forgets outcomes but keeps listeners: rows drawn before a resume still need theirs. */
    clear(): void {
        this.outcomes.clear();
        this.running.clear();
    }
}

export const jobOutcomes = new JobOutcomes();
