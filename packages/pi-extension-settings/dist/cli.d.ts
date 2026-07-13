export type CliIo = {
    readonly stdout: (message: string) => void;
    readonly stderr: (message: string) => void;
};
/** Run the CLI and return a process exit code without terminating the host process. */
export declare function runCli(args: readonly string[], io?: CliIo): Promise<number>;
//# sourceMappingURL=cli.d.ts.map