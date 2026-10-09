import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Glob } from "glob";
import { Compile } from "typebox/compile";
import { Type, type Static } from "typebox";
import type { FactArguments, FactResolution, FactScalar } from "./condition.ts";

const contextValueTypeSchema = Type.Enum(["string", "number", "boolean", "null"] as const);
const contextScalarSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

const registerContextKeySchema = Type.Object(
    {
        key: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" }),
        type: contextValueTypeSchema,
        description: Type.String({ minLength: 1, maxLength: 500 }),
        owner: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);

const setContextSchema = Type.Object(
    {
        key: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" }),
        value: contextScalarSchema,
        owner: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);

const clearContextSchema = Type.Object(
    {
        key: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" })),
        owner: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);

const registerContextKeyValidator = Compile(registerContextKeySchema);
const setContextValidator = Compile(setContextSchema);
const clearContextValidator = Compile(clearContextSchema);
const RESERVED_DYNAMIC_FACTS = new Set(["env.present", "project.fileExists", "project.hasAnyFile"]);

export type RegisterContextKeyInput = Static<typeof registerContextKeySchema>;
export type SetContextInput = Static<typeof setContextSchema>;
export type ClearContextInput = Static<typeof clearContextSchema>;

export type ContextEventParseResult<T> =
    | { readonly status: "ok"; readonly value: T }
    | { readonly status: "invalid"; readonly message: string };

type RegisteredContextKey = RegisterContextKeyInput & { readonly value?: FactScalar };

function parseWithValidator<T>(
    value: unknown,
    validator: { Parse(input: unknown): T },
): ContextEventParseResult<T> {
    try {
        return { status: "ok", value: validator.Parse(value) };
    } catch (cause: unknown) {
        return {
            status: "invalid",
            message: cause instanceof Error ? cause.message : String(cause),
        };
    }
}

export function parseRegisterContextKey(
    value: unknown,
): ContextEventParseResult<RegisterContextKeyInput> {
    return parseWithValidator(value, registerContextKeyValidator);
}

export function parseSetContext(value: unknown): ContextEventParseResult<SetContextInput> {
    return parseWithValidator(value, setContextValidator);
}

export function parseClearContext(value: unknown): ContextEventParseResult<ClearContextInput> {
    return parseWithValidator(value, clearContextValidator);
}

function valueMatchesType(value: FactScalar, type: RegisterContextKeyInput["type"]): boolean {
    if (value === null) {
        return type === "null";
    }
    return typeof value === type;
}

function getStringArg(args: FactArguments | undefined, key: string): string | undefined {
    const value = args?.[key];
    return typeof value === "string" ? value : undefined;
}

function isWithin(root: string, target: string): boolean {
    const fromProject = relative(root, target);
    return (
        fromProject !== ".." &&
        !fromProject.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    );
}

function isProjectRelativePath(cwd: string, candidate: string): boolean {
    if (isAbsolute(candidate)) {
        return false;
    }
    return isWithin(cwd, resolve(cwd, candidate));
}

export class ContextFacts {
    readonly #values = new Map<string, FactScalar>();
    readonly #contextKeys = new Map<string, RegisteredContextKey>();
    readonly #diagnostics: string[] = [];
    #cwd: string;
    #projectTrusted: boolean;

    constructor(cwd: string, projectTrusted: boolean) {
        this.#cwd = cwd;
        this.#projectTrusted = projectTrusted;
    }

    get diagnostics(): readonly string[] {
        return this.#diagnostics;
    }

    updateProject(cwd: string, trusted: boolean): void {
        this.#cwd = cwd;
        this.#projectTrusted = trusted;
        this.#values.set("project.cwd", cwd);
        this.#values.set("project.trusted", trusted);
    }

    set(name: string, value: FactScalar | undefined): void {
        if (value === undefined) {
            this.#values.delete(name);
            return;
        }
        this.#values.set(name, value);
    }

    registerContextKey(input: RegisterContextKeyInput): void {
        if (this.#values.has(input.key) || RESERVED_DYNAMIC_FACTS.has(input.key)) {
            this.addDiagnostic(`Context key ${input.key} is reserved by Pi Toggles.`);
            return;
        }
        const current = this.#contextKeys.get(input.key);
        if (current !== undefined && current.owner !== input.owner) {
            this.addDiagnostic(
                `Context key ${input.key} is already owned by ${current.owner}; ignored registration from ${input.owner}.`,
            );
            return;
        }
        this.#contextKeys.set(input.key, {
            ...input,
            ...(current?.value === undefined ? {} : { value: current.value }),
        });
    }

    setContext(input: SetContextInput): void {
        const registered = this.#contextKeys.get(input.key);
        if (registered === undefined) {
            this.addDiagnostic(`Context key ${input.key} was set before it was registered.`);
            return;
        }
        if (registered.owner !== input.owner) {
            this.addDiagnostic(
                `Context key ${input.key} is owned by ${registered.owner}, not ${input.owner}.`,
            );
            return;
        }
        if (!valueMatchesType(input.value, registered.type)) {
            this.addDiagnostic(`Context key ${input.key} expected ${registered.type}.`);
            return;
        }
        this.#contextKeys.set(input.key, { ...registered, value: input.value });
    }

    clearContext(input: ClearContextInput): void {
        for (const [key, registered] of this.#contextKeys) {
            if (
                registered.owner === input.owner &&
                (input.key === undefined || input.key === key)
            ) {
                this.#contextKeys.set(key, {
                    key: registered.key,
                    type: registered.type,
                    description: registered.description,
                    owner: registered.owner,
                });
            }
        }
    }

    resolve = (name: string, args: FactArguments | undefined): FactResolution => {
        const direct = this.#values.get(name);
        if (direct !== undefined || this.#values.has(name)) {
            return { status: "known", value: direct ?? null };
        }

        const registered = this.#contextKeys.get(name);
        if (registered !== undefined) {
            return registered.value === undefined
                ? {
                      status: "missing",
                      reason: `Context provider ${registered.owner} has not supplied a value.`,
                  }
                : { status: "known", value: registered.value };
        }

        if (name === "env.present") {
            const variable = getStringArg(args, "name");
            return variable === undefined
                ? { status: "unknown", reason: "env.present requires string argument name." }
                : { status: "known", value: process.env[variable] !== undefined };
        }

        if (name === "project.fileExists") {
            return this.resolveFileExists(args);
        }

        if (name === "project.hasAnyFile") {
            return this.resolveHasAnyFile(args);
        }

        return {
            status: "missing",
            reason: "No built-in or extension context provider is registered.",
        };
    };

    private resolveFileExists(args: FactArguments | undefined): FactResolution {
        if (!this.#projectTrusted) {
            return { status: "unknown", reason: "Project file facts require project trust." };
        }
        const path = getStringArg(args, "path");
        if (path === undefined || !isProjectRelativePath(this.#cwd, path)) {
            return {
                status: "unknown",
                reason: "project.fileExists requires a project-relative path.",
            };
        }
        const candidate = resolve(this.#cwd, path);
        if (!existsSync(candidate)) {
            return { status: "known", value: false };
        }
        try {
            if (!isWithin(realpathSync(this.#cwd), realpathSync(candidate))) {
                return {
                    status: "unknown",
                    reason: "project.fileExists resolves outside the trusted project.",
                };
            }
        } catch {
            return { status: "unknown", reason: "project.fileExists could not resolve the path." };
        }
        return { status: "known", value: true };
    }

    private resolveHasAnyFile(args: FactArguments | undefined): FactResolution {
        if (!this.#projectTrusted) {
            return { status: "unknown", reason: "Project file facts require project trust." };
        }
        const patterns = getStringArg(args, "patterns");
        if (patterns === undefined) {
            return {
                status: "unknown",
                reason: "project.hasAnyFile requires comma-separated string argument patterns.",
            };
        }
        const globs = patterns
            .split(",")
            .map((pattern) => pattern.trim())
            .filter(
                (pattern) =>
                    pattern.length > 0 &&
                    !isAbsolute(pattern) &&
                    !pattern.split(/[\\/]/).includes(".."),
            );
        if (globs.length === 0) {
            return {
                status: "unknown",
                reason: "project.hasAnyFile received no safe relative patterns.",
            };
        }
        const matches = new Glob(globs, {
            cwd: this.#cwd,
            nodir: true,
            dot: true,
            maxDepth: 12,
            ignore: ["node_modules/**", ".git/**"],
        });
        return { status: "known", value: !matches.iterateSync().next().done };
    }

    private addDiagnostic(message: string): void {
        if (this.#diagnostics.length < 100 && !this.#diagnostics.includes(message)) {
            this.#diagnostics.push(message);
        }
    }
}
