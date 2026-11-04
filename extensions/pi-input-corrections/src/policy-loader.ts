import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { Value } from "typebox/value";
import { createCorrectionEngine, type CorrectionEngine } from "./correction-engine.ts";
import { policySchema } from "./policy-input.ts";

export { policySchema, ruleSchema } from "./policy-input.ts";
export type { CorrectionPolicy, CorrectionRule } from "./policy-input.ts";

export type CorrectionPolicyDiagnostic = { message: string; severity: "warning" | "error" };

export type LoadedCorrectionPolicy = {
    engine: CorrectionEngine;
    diagnostics: CorrectionPolicyDiagnostic[];
};

function disabledPolicy(message?: string): LoadedCorrectionPolicy {
    const diagnostics: CorrectionPolicyDiagnostic[] = [];
    if (message !== undefined) diagnostics.push({ message, severity: "error" });

    return {
        engine: createCorrectionEngine({ enabled: false, trailingQuestionMark: false, rules: [] }),
        diagnostics,
    };
}

function expandHome(path: string): string {
    if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));

    return path;
}

/** Synchronous, value-safe boundary; adapters cache the result once per session. */
export function loadCorrectionPolicy(
    policyFile: string,
    configFile: string,
): LoadedCorrectionPolicy {
    if (policyFile === "") return disabledPolicy();

    // A relative config file has no stable base: do not silently interpret it against cwd.
    const configPath = expandHome(configFile);
    if (!isAbsolute(configPath))
        return disabledPolicy(
            "Correction settings file must have an absolute path; corrections disabled.",
        );

    const policyPath = resolve(dirname(configPath), expandHome(policyFile));
    let content: string;
    try {
        content = readFileSync(policyPath, "utf8");
    } catch {
        return disabledPolicy(
            "Correction policy could not be read. Check policyFile and file permissions; corrections disabled.",
        );
    }

    let value: unknown;
    try {
        value = JSON.parse(content);
    } catch {
        return disabledPolicy(
            "Correction policy is not valid JSON. Fix the personal policy file; corrections disabled.",
        );
    }

    if (!Value.Check(policySchema, value))
        return disabledPolicy(
            "Correction policy has an invalid structure. Validate it against policy.schema.json; corrections disabled.",
        );

    const engine = createCorrectionEngine({
        enabled: true,
        trailingQuestionMark: value.trailingQuestionMark ?? true,
        rules: value.rules,
    });

    return {
        engine,
        diagnostics: engine.diagnostics.map((message) => ({ message, severity: "warning" })),
    };
}
