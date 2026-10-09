import { execFile } from "node:child_process";

const GIT_AHEAD_BEHIND_REFRESH_INTERVAL_MS = 5_000;
const GIT_AHEAD_BEHIND_TIMEOUT_MS = 1_000;

export type GitAheadBehind = {
    readonly ahead: number;
    readonly behind: number;
};

export type GitAheadBehindSource = {
    getGitAheadBehind(): GitAheadBehind | undefined;
    refresh(): void;
    dispose(): void;
};

type GitAheadBehindQuery = (
    cwd: string,
    options: { readonly signal: AbortSignal },
) => Promise<GitAheadBehind | undefined>;

export type GitAheadBehindTrackerOptions = {
    readonly query?: GitAheadBehindQuery;
    readonly refreshIntervalMs?: number;
};

function isAbortCause(cause: unknown): boolean {
    return cause instanceof Error && cause.name === "AbortError";
}

function parseGitAheadBehind(output: string): GitAheadBehind | undefined {
    const counts = output.trim().split(/\s+/);
    if (counts.length !== 2) return undefined;

    const aheadText = counts.at(0);
    const behindText = counts.at(1);
    if (aheadText === undefined || behindText === undefined) return undefined;

    const ahead = Number(aheadText);
    const behind = Number(behindText);
    if (!Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) {
        return undefined;
    }

    return { ahead, behind };
}

async function runGitAheadBehindQuery(
    cwd: string,
    options: { readonly signal: AbortSignal },
): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            "git",
            ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            {
                cwd,
                encoding: "utf8",
                signal: options.signal,
                timeout: GIT_AHEAD_BEHIND_TIMEOUT_MS,
                windowsHide: true,
            },
            (error, stdout) => {
                if (error instanceof Error) {
                    reject(error);
                    return;
                }

                resolve(stdout);
            },
        );
    });
}

async function loadGitAheadBehind(
    cwd: string,
    options: { readonly signal: AbortSignal },
): Promise<GitAheadBehind | undefined> {
    try {
        options.signal.throwIfAborted();
        const output = await runGitAheadBehindQuery(cwd, options);
        options.signal.throwIfAborted();
        return parseGitAheadBehind(output);
    } catch (cause: unknown) {
        if (options.signal.aborted || isAbortCause(cause)) {
            return undefined;
        }

        // Repositories without an upstream (and unavailable Git installations)
        // have no meaningful ahead/behind indicator, so keep the footer quiet.
        return undefined;
    }
}

function gitAheadBehindEqual(
    left: GitAheadBehind | undefined,
    right: GitAheadBehind | undefined,
): boolean {
    if (left === undefined || right === undefined) return left === right;
    return left.ahead === right.ahead && left.behind === right.behind;
}

class GitAheadBehindTracker implements GitAheadBehindSource {
    private readonly abortController = new AbortController();
    private readonly query: GitAheadBehindQuery;
    private readonly refreshIntervalMs: number;
    private readonly requestRender: () => void;
    private readonly cwd: string;
    private refreshTimer: ReturnType<typeof setInterval> | undefined;
    private refreshInFlight: Promise<void> | undefined;
    private refreshPending = false;
    private disposed = false;
    private gitAheadBehind: GitAheadBehind | undefined;

    constructor(cwd: string, requestRender: () => void, options: GitAheadBehindTrackerOptions) {
        this.cwd = cwd;
        this.requestRender = requestRender;
        this.query = options.query ?? loadGitAheadBehind;
        this.refreshIntervalMs = options.refreshIntervalMs ?? GIT_AHEAD_BEHIND_REFRESH_INTERVAL_MS;
        this.refresh();

        if (this.refreshIntervalMs > 0) {
            this.refreshTimer = setInterval(() => this.refresh(), this.refreshIntervalMs);
            this.refreshTimer.unref();
        }
    }

    getGitAheadBehind(): GitAheadBehind | undefined {
        return this.gitAheadBehind;
    }

    refresh(): void {
        if (this.disposed) return;

        if (this.refreshInFlight !== undefined) {
            this.refreshPending = true;
            return;
        }

        this.refreshInFlight = this.loadCurrentStatus();
    }

    dispose(): void {
        if (this.disposed) return;

        this.disposed = true;
        this.abortController.abort();

        if (this.refreshTimer !== undefined) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private async loadCurrentStatus(): Promise<void> {
        try {
            // Start queries after refresh() records this promise as in-flight, so
            // even a faulty injected query that throws synchronously cannot leave
            // the tracker permanently marked as busy.
            await Promise.resolve();

            const nextStatus = await this.query(this.cwd, {
                signal: this.abortController.signal,
            });
            if (!this.disposed) {
                this.setGitAheadBehind(nextStatus);
            }
        } catch (cause: unknown) {
            if (this.disposed || this.abortController.signal.aborted || isAbortCause(cause)) {
                return;
            }

            this.setGitAheadBehind(undefined);
        } finally {
            this.refreshInFlight = undefined;

            if (!this.disposed && this.refreshPending) {
                this.refreshPending = false;
                this.refresh();
            }
        }
    }

    private setGitAheadBehind(nextStatus: GitAheadBehind | undefined): void {
        if (gitAheadBehindEqual(this.gitAheadBehind, nextStatus)) return;

        this.gitAheadBehind = nextStatus;
        this.requestRender();
    }
}

export function createGitAheadBehindTracker(
    cwd: string,
    requestRender: () => void,
    options: GitAheadBehindTrackerOptions = {},
): GitAheadBehindSource {
    return new GitAheadBehindTracker(cwd, requestRender, options);
}

export function formatGitAheadBehind(gitAheadBehind: GitAheadBehind): string {
    return `↑${gitAheadBehind.ahead} ↓${gitAheadBehind.behind}`;
}
