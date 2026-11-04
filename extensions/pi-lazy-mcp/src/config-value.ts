import { execSync } from "node:child_process";

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;
const COMMAND_TIMEOUT_MS = 10_000;

function parseTemplate(value: string): TemplatePart[] {
    const parts: TemplatePart[] = [];
    const literal = (text: string): void => {
        if (text !== "") parts.push({ type: "literal", value: text });
    };

    let index = 0;
    while (index < value.length) {
        const dollar = value.indexOf("$", index);
        if (dollar < 0) {
            literal(value.slice(index));
            break;
        }

        literal(value.slice(index, dollar));

        const next = value[dollar + 1];
        if (next === "$" || next === "!") {
            literal(next);
            index = dollar + 2;
            continue;
        }

        if (next === "{") {
            const end = value.indexOf("}", dollar + 2);
            if (end < 0) {
                literal("$");
                index = dollar + 1;
                continue;
            }

            const name = value.slice(dollar + 2, end);
            if (ENV_NAME.test(name)) parts.push({ type: "env", name });
            else literal(value.slice(dollar, end + 1));

            index = end + 1;
            continue;
        }

        const name = ENV_NAME_PREFIX.exec(value.slice(dollar + 1))?.[0];
        if (name !== undefined) {
            parts.push({ type: "env", name });
            index = dollar + 1 + name.length;
            continue;
        }

        literal("$");
        index = dollar + 1;
    }

    return parts;
}

function runCommand(command: string): string | undefined {
    try {
        const output = execSync(command, {
            encoding: "utf8",
            timeout: COMMAND_TIMEOUT_MS,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (output !== "") return output;

        return undefined;
    } catch {
        return undefined;
    }
}

function environmentValue(name: string): string | undefined {
    const value = process.env[name];
    if (value === "") return undefined;

    return value;
}

export function resolveConfigValue(value: string, description: string): string {
    if (value.startsWith("!")) {
        const output = runCommand(value.slice(1));
        if (output === undefined)
            throw new Error(`Failed to resolve ${description} from its shell command`);

        return output;
    }

    const parts = parseTemplate(value);
    const missing = new Set<string>();
    let resolved = "";
    for (const part of parts) {
        if (part.type === "literal") {
            resolved += part.value;
            continue;
        }

        const variable = environmentValue(part.name);
        if (variable === undefined) missing.add(part.name);
        else resolved += variable;
    }

    if (missing.size === 1)
        throw new Error(
            `Failed to resolve ${description} from environment variable: ${[...missing].join("")}`,
        );

    if (missing.size > 1)
        throw new Error(
            `Failed to resolve ${description} from environment variables: ${[...missing].join(", ")}`,
        );

    return resolved;
}
