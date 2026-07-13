#!/usr/bin/env node
import process from "node:process";
import { runCli } from "./cli.js";
process.exitCode = await runCli(process.argv.slice(2));
//# sourceMappingURL=cli-entry.js.map