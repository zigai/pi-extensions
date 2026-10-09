import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import {
    createListProvider,
    registerMention,
    type Candidate,
} from "@zigai/pi-mention-anything/api";

export default function (pi: ExtensionAPI): void {
    registerMention(pi, {
        id: "tmux",
        configuration: () => ({ trigger: "t:", separator: ":", cache: true, cacheTtlMs: 5000 }),
        provider: (ctx) =>
            createListProvider(async (request) => {
                const parent = request.path.at(-1);
                const level = request.path.length;
                if (level > 2) return [];

                let args: string[];
                if (level === 0) args = ["list-sessions", "-F", "#{session_id}\t#{session_name}"];
                else if (level === 1 && parent !== undefined)
                    args = ["list-windows", "-t", parent.id, "-F", "#{window_id}\t#{window_name}"];
                else if (parent !== undefined)
                    args = [
                        "list-panes",
                        "-t",
                        parent.id,
                        "-F",
                        "#{pane_id}\t#{pane_index}\t#{pane_current_command}",
                    ];
                else return [];

                const stdout = await new Promise<string>((resolve, reject) => {
                    execFile(
                        "tmux",
                        args,
                        {
                            cwd: ctx.cwd,
                            signal: request.signal,
                            timeout: 5000,
                            maxBuffer: 1048576,
                        },
                        (cause, output) => {
                            if (cause instanceof Error) reject(cause);
                            else if (cause !== null)
                                reject(new Error("tmux listing failed.", { cause }));
                            else resolve(output);
                        },
                    );
                });

                return stdout
                    .trim()
                    .split("\n")
                    .filter(Boolean)
                    .map((line): Candidate => {
                        const columns = line.split("\t");
                        const id = columns.at(0);
                        const segment = columns.at(1);
                        const command = columns.at(2);

                        if (
                            id === undefined ||
                            id.length === 0 ||
                            segment === undefined ||
                            segment.length === 0
                        )
                            throw new Error("Invalid tmux listing.");

                        let description = id;
                        if (command !== undefined) description = `${id} ${command}`;

                        const candidate: Candidate = {
                            id,
                            label: segment,
                            segment,
                            description,
                            selectable: level === 2,
                            navigable: level < 2,
                        };
                        if (level !== 2) return candidate;

                        return {
                            ...candidate,
                            replacement: `tmux pane ${id} in session ${request.path[0]?.segment}, window ${parent?.segment} (window ID ${parent?.id})`,
                        };
                    });
            }),
    });
}
