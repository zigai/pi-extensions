import { execFileSync } from "node:child_process";
import process from "node:process";

function gitOutput(args: readonly string[]): string {
    return execFileSync("git", args, { encoding: "utf8" });
}

const changed = gitOutput(["diff", "--name-only", "--", "dist"]);
const untracked = gitOutput(["ls-files", "--others", "--exclude-standard", "--", "dist"]);
const stale = `${changed}${untracked}`;

if (stale.trim() !== "") {
    process.stderr.write("Compiled dist artifacts are missing or stale:\n");
    process.stderr.write(stale);
    process.exitCode = 1;
}
