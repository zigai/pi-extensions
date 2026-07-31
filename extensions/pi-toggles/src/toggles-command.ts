import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { getDesiredStates, selectorForCapability, type Capability } from "./capability.ts";
import type { PolicyScope } from "./capability-policy.ts";
import type { EffectiveCapability } from "./resolve-capability-policy.ts";
import type { DesiredState, PolicyDecision } from "./settings.ts";
import { TogglesPanel, type PanelItem } from "./toggles-panel.ts";
import type { MutationResult, TogglesService } from "./toggles-service.ts";

type NotificationSeverity = "info" | "warning" | "error";

function report(
    ctx: ExtensionCommandContext,
    message: string,
    severity: NotificationSeverity,
): void {
    if (ctx.hasUI) {
        ctx.ui.notify(message, severity);
        return;
    }
    process.stderr.write(`[pi-toggles:${severity}] ${message}\n`);
}

type CommandRequest =
    | { readonly action: "panel" }
    | { readonly action: "list"; readonly kind?: string }
    | {
          readonly action: "set";
          readonly reference: string;
          readonly state: DesiredState;
          readonly scope: PolicyScope;
      }
    | { readonly action: "reset"; readonly reference?: string; readonly scope: PolicyScope }
    | { readonly action: "profile"; readonly profile?: string; readonly scope: PolicyScope }
    | { readonly action: "explain"; readonly reference: string }
    | { readonly action: "refresh" }
    | { readonly action: "doctor" }
    | { readonly action: "help" };

type ParseResult =
    | { readonly status: "ok"; readonly request: CommandRequest }
    | { readonly status: "invalid"; readonly message: string };

const desiredStates: readonly DesiredState[] = [
    "inherit",
    "on",
    "off",
    "lazy",
    "name-only",
    "user-only",
];

function parseDesiredState(value: string | undefined): DesiredState | undefined {
    return desiredStates.find((state) => state === value);
}

function parsePolicyScope(value: string | undefined): PolicyScope | undefined {
    switch (value) {
        case "global":
        case "project":
        case "session":
            return value;
        case undefined:
            return undefined;
        default:
            return undefined;
    }
}

const commandHelp = `Usage:
/toggles
/toggles list [kind]
/toggles set <capability> <state> [--scope session|global|project]
/toggles reset [capability] [--scope session|global|project]
/toggles profile <name|none> [--scope session|global|project]
/toggles explain <capability>
/toggles refresh
/toggles doctor`;

function tokenize(
    input: string,
):
    | { readonly status: "ok"; readonly tokens: readonly string[] }
    | { readonly status: "invalid"; readonly message: string } {
    const tokens: string[] = [];
    let current = "";
    let quote: '"' | "'" | undefined;
    for (const character of input.trim()) {
        if (quote !== undefined) {
            if (character === quote) {
                quote = undefined;
            } else {
                current += character;
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (/\s/.test(character)) {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
        } else {
            current += character;
        }
    }
    if (quote !== undefined) {
        return { status: "invalid", message: "Unterminated quoted argument." };
    }
    if (current.length > 0) {
        tokens.push(current);
    }
    return { status: "ok", tokens };
}

function parseScope(
    tokens: readonly string[],
): ParseResult | { readonly scope: PolicyScope; readonly rest: readonly string[] } {
    const scopeIndex = tokens.indexOf("--scope");
    if (scopeIndex === -1) {
        return { scope: "session", rest: tokens };
    }
    const value = tokens[scopeIndex + 1];
    const scope = parsePolicyScope(value);
    if (scope === undefined) {
        return { status: "invalid", message: "--scope must be session, global, or project." };
    }
    return {
        scope,
        rest: tokens.filter((_token, index) => index !== scopeIndex && index !== scopeIndex + 1),
    };
}

export function parseTogglesCommand(input: string): ParseResult {
    const tokenized = tokenize(input);
    if (tokenized.status === "invalid") {
        return tokenized;
    }
    if (tokenized.tokens.length === 0) {
        return { status: "ok", request: { action: "panel" } };
    }
    const scoped = parseScope(tokenized.tokens);
    if ("status" in scoped) {
        return scoped;
    }
    const [action, ...args] = scoped.rest;
    if (action === undefined) {
        return { status: "invalid", message: "Missing action." };
    }
    switch (action) {
        case "list":
            if (args.length > 1) {
                return { status: "invalid", message: "list accepts at most one capability kind." };
            }
            return {
                status: "ok",
                request: { action: "list", ...(args[0] === undefined ? {} : { kind: args[0] }) },
            };
        case "set": {
            const [reference, state] = args;
            const desiredState = parseDesiredState(state);
            if (args.length !== 2 || reference === undefined || desiredState === undefined) {
                return { status: "invalid", message: "set requires a capability and valid state." };
            }
            return {
                status: "ok",
                request: { action: "set", reference, state: desiredState, scope: scoped.scope },
            };
        }
        case "reset":
            if (args.length > 1) {
                return { status: "invalid", message: "reset accepts at most one capability." };
            }
            return {
                status: "ok",
                request: {
                    action: "reset",
                    ...(args[0] === undefined ? {} : { reference: args[0] }),
                    scope: scoped.scope,
                },
            };
        case "profile": {
            const profile = args[0];
            if (args.length !== 1 || profile === undefined) {
                return { status: "invalid", message: "profile requires a profile name or none." };
            }
            return {
                status: "ok",
                request: {
                    action: "profile",
                    ...(profile === "none" ? {} : { profile }),
                    scope: scoped.scope,
                },
            };
        }
        case "explain":
            return args.length !== 1 || args[0] === undefined
                ? { status: "invalid", message: "explain requires a capability." }
                : { status: "ok", request: { action: "explain", reference: args[0] } };
        case "refresh":
            if (args.length !== 0) {
                return { status: "invalid", message: "refresh accepts no arguments." };
            }
            return { status: "ok", request: { action: "refresh" } };
        case "doctor":
            if (args.length !== 0) {
                return { status: "invalid", message: "doctor accepts no arguments." };
            }
            return { status: "ok", request: { action: "doctor" } };
        case "help":
            if (args.length !== 0) {
                return { status: "invalid", message: "help accepts no arguments." };
            }
            return { status: "ok", request: { action: "help" } };
        default:
            return { status: "invalid", message: `Unknown action ${action ?? ""}.` };
    }
}

function formatMutation(result: MutationResult): {
    readonly message: string;
    readonly severity: "info" | "error" | "warning";
} {
    if (result.status === "applied") {
        return { message: "Pi Toggles policy applied.", severity: "info" };
    }
    return {
        message: result.message,
        severity: result.status === "failed" ? "error" : "warning",
    };
}

async function showText(
    title: string,
    content: string,
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (ctx.mode !== "tui") {
        report(ctx, `${title}\n${content}`, "info");
        return;
    }
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
        container.addChild(new Text(content, 1, 1));
        container.addChild(new Text(theme.fg("dim", "enter/esc close"), 1, 0));
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
                if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
                    done(undefined);
                }
                tui.requestRender();
            },
        };
    });
}

function panelValues(capability: Capability): readonly DesiredState[] | undefined {
    if (capability.observedState === "unavailable") {
        return ["inherit"];
    }
    if (capability.protected) {
        return capability.supported ? ["inherit", "on"] : ["inherit"];
    }
    if (!capability.supported) {
        return undefined;
    }
    return getDesiredStates(capability.kind);
}

function conciseDescription(description: string | undefined): string | undefined {
    if (description === undefined) {
        return undefined;
    }
    const normalized = description.replaceAll(/\s+/g, " ").trim();
    if (normalized.length <= 180) {
        return normalized;
    }
    return `${normalized.slice(0, 179).trimEnd()}…`;
}

export function capabilityPanelColumns(
    capability: Capability,
    effective: EffectiveCapability | undefined,
): Pick<PanelItem, "effectiveValue" | "decidedBy" | "description"> {
    const description = conciseDescription(capability.description) ?? "No description provided";
    if (!capability.supported) {
        return {
            effectiveValue: "unsupported",
            decidedBy: "Pi API",
            description,
        };
    }
    if (capability.observedState === "unavailable") {
        return {
            effectiveValue: "unavailable",
            decidedBy: "Pi",
            description,
        };
    }
    const winner = effective?.winner;
    const decidedBy =
        winner === undefined
            ? "Pi"
            : winner.origin === "extension-proposal"
              ? `extension ${winner.source}`
              : winner.origin === "override"
                ? winner.scope
                : winner.origin === "profile"
                  ? `${winner.scope} profile`
                  : `${winner.scope} rule`;
    return {
        effectiveValue: effective?.effectiveState ?? capability.observedState,
        decidedBy,
        description: capability.protected
            ? `Protected recovery capability. ${description}`
            : description,
    };
}

type PanelResult =
    | { readonly action: "cancel" }
    | {
          readonly action: "apply";
          readonly decisions: readonly PolicyDecision[];
          readonly activeProfile: string | undefined;
          readonly profileChanged: boolean;
      };

const ACTIVE_PROFILE_ITEM_ID = "__pi-toggles-active-profile__";

async function chooseScope(ctx: ExtensionCommandContext): Promise<PolicyScope | undefined> {
    const options = ["session — current session", "global — all projects"];
    if (ctx.isProjectTrusted()) {
        options.splice(1, 0, "project — current trusted project");
    }
    const selected = await ctx.ui.select("Pi Toggles policy scope", options);
    return parsePolicyScope(selected?.split(" ", 1)[0]);
}

async function showPanel(service: TogglesService, ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") {
        report(ctx, "/toggles without arguments requires TUI mode. Use /toggles help.", "warning");
        return;
    }
    const scope = await chooseScope(ctx);
    if (scope === undefined) {
        return;
    }
    const staged = new Map<string, DesiredState>();
    let activeProfile = service.getActiveProfile(scope);
    let profileChanged = false;
    const result = await ctx.ui.custom<PanelResult>((tui, theme, _keybindings, done) => {
        const capabilityNameCounts = new Map<string, number>();
        for (const capability of service.catalog) {
            const key = `${capability.kind}\0${capability.name}`;
            capabilityNameCounts.set(key, (capabilityNameCounts.get(key) ?? 0) + 1);
        }
        const capabilityItems: PanelItem[] = service.catalog.map((capability) => {
            const effective = service.getEffectiveCapability(capability);
            const values = panelValues(capability);
            const hasDuplicateName =
                (capabilityNameCounts.get(`${capability.kind}\0${capability.name}`) ?? 0) > 1;
            return {
                id: capability.id,
                category: capability.kind,
                label: hasDuplicateName
                    ? `${capability.name} · ${capability.source.source}`
                    : capability.name,
                currentValue:
                    values === undefined
                        ? "unsupported"
                        : service.getScopedState(capability, scope),
                ...capabilityPanelColumns(capability, effective),
                ...(values === undefined ? {} : { values: [...values] }),
            };
        });
        const items: PanelItem[] = [
            {
                id: ACTIVE_PROFILE_ITEM_ID,
                category: "profile",
                label: "Active profile",
                currentValue: activeProfile ?? "none",
                effectiveValue: activeProfile ?? "none",
                decidedBy: scope,
                description: "Named policy bundle selected for this scope",
                values: [
                    "none",
                    ...new Set([
                        ...service.getProfileNames(scope),
                        ...(activeProfile === undefined ? [] : [activeProfile]),
                    ]),
                ],
            },
            ...capabilityItems,
        ];
        const panel = new TogglesPanel(
            items,
            scope,
            {
                accent: (text) => theme.fg("accent", text),
                text: (text) => theme.fg("text", text),
                muted: (text) => theme.fg("muted", text),
                dim: (text) => theme.fg("dim", text),
                warning: (text) => theme.fg("warning", text),
                success: (text) => theme.fg("success", text),
                error: (text) => theme.fg("error", text),
                selected: (text) => theme.bg("selectedBg", text),
                bold: (text) => theme.bold(text),
                border: (text) => theme.fg("borderMuted", text),
            },
            (id, value) => {
                if (id === ACTIVE_PROFILE_ITEM_ID) {
                    activeProfile = value === "none" ? undefined : value;
                    profileChanged = true;
                    return;
                }
                const state = parseDesiredState(value);
                if (state !== undefined) {
                    staged.set(id, state);
                }
            },
            () => done({ action: "cancel" }),
        );
        return {
            get focused(): boolean {
                return panel.focused;
            },
            set focused(value: boolean) {
                panel.focused = value;
            },
            render: (width: number) => panel.render(width),
            invalidate: () => panel.invalidate(),
            handleInput: (data: string) => {
                if (matchesKey(data, Key.ctrl("s"))) {
                    const decisions = [...staged].flatMap(([id, state]) => {
                        const capability = service.catalog.find((candidate) => candidate.id === id);
                        return capability === undefined
                            ? []
                            : [{ target: selectorForCapability(capability), state }];
                    });
                    done({
                        action: "apply",
                        decisions,
                        activeProfile,
                        profileChanged,
                    });
                    return;
                }
                panel.handleInput(data);
                tui.requestRender();
            },
        };
    });
    if (result.action !== "apply" || (result.decisions.length === 0 && !result.profileChanged)) {
        return;
    }
    const leavesNoTools = service.wouldLeaveNoActiveModelTools(
        scope,
        result.decisions,
        result.activeProfile,
    );
    if (scope !== "session" || leavesNoTools) {
        const decisionDiff = result.decisions
            .map((decision) => `${JSON.stringify(decision.target)} -> ${decision.state}`)
            .join("\n");
        const exactDiff = [
            ...(result.profileChanged
                ? [`activeProfile -> ${result.activeProfile ?? "none"}`]
                : []),
            ...(decisionDiff.length === 0 ? [] : [decisionDiff]),
        ].join("\n");
        const confirmed = await ctx.ui.confirm(
            leavesNoTools
                ? "Apply policy with no model tools?"
                : `Save ${scope} Pi Toggles policy?`,
            `${scope === "session" ? "The following session policy diff will be applied" : "The following policy diff will be persisted"}:\n\n${exactDiff}${leavesNoTools ? "\n\nThis leaves no active model tools except the protected capability search tool." : ""}`,
        );
        if (!confirmed) {
            return;
        }
    }
    const mutation = await service.applyPanelPolicy(scope, result.decisions, result.activeProfile);
    const formatted = formatMutation(mutation);
    report(ctx, formatted.message, formatted.severity);
}

function formatList(service: TogglesService, kind?: string): string {
    const capabilities = service.catalog.filter(
        (capability) => kind === undefined || capability.kind === kind,
    );
    if (capabilities.length === 0) {
        return "No matching capabilities.";
    }
    const displayed = capabilities.slice(0, 500);
    const content = displayed
        .map((capability) => {
            const effective = service.getEffectiveCapability(capability);
            return `${capability.kind.padEnd(16)} ${capability.name.padEnd(28)} ${(effective?.effectiveState ?? capability.observedState).padEnd(12)} ${capability.source.source}`;
        })
        .join("\n");
    const omitted = capabilities.length - displayed.length;
    return omitted === 0 ? content : `${content}\n… ${omitted} additional capabilities omitted.`;
}

function doctorText(service: TogglesService): string {
    const diagnostics = service.diagnostics;
    const gaps = [
        "Pi API gap: only the winning implementation for a duplicated tool name is exposed, so implementation selection cannot be centrally managed.",
        "Pi API gap: extension slash commands run before the interceptable input event and cannot be centrally gated.",
        "Pi API gap: built-in slash commands have no complete public catalog or invocation gate.",
    ];
    return [
        ...gaps,
        "",
        diagnostics.length === 0 ? "No policy diagnostics." : diagnostics.join("\n"),
    ].join("\n");
}

export async function handleTogglesCommand(
    args: string,
    ctx: ExtensionCommandContext,
    service: TogglesService,
): Promise<void> {
    const parsed = parseTogglesCommand(args);
    if (parsed.status === "invalid") {
        report(ctx, `${parsed.message}\n${commandHelp}`, "warning");
        return;
    }
    const request = parsed.request;
    switch (request.action) {
        case "panel":
            await showPanel(service, ctx);
            return;
        case "list":
            await showText("Pi capability catalog", formatList(service, request.kind), ctx);
            return;
        case "set": {
            const found = service.findCapability(request.reference);
            if (found.status !== "found") {
                report(ctx, found.message, "warning");
                return;
            }
            const mutation = await service.setCapabilityState(
                request.scope,
                found.capability,
                request.state,
            );
            const formatted = formatMutation(mutation);
            report(ctx, formatted.message, formatted.severity);
            return;
        }
        case "reset": {
            let mutation: MutationResult;
            if (request.reference === undefined) {
                mutation = await service.clearScope(request.scope);
            } else {
                const found = service.findCapability(request.reference);
                if (found.status !== "found") {
                    report(ctx, found.message, "warning");
                    return;
                }
                mutation = await service.setCapabilityState(
                    request.scope,
                    found.capability,
                    "inherit",
                );
            }
            const formatted = formatMutation(mutation);
            report(ctx, formatted.message, formatted.severity);
            return;
        }
        case "profile": {
            const mutation = await service.setActiveProfile(request.scope, request.profile);
            const formatted = formatMutation(mutation);
            report(ctx, formatted.message, formatted.severity);
            return;
        }
        case "explain": {
            const found = service.findCapability(request.reference);
            if (found.status !== "found") {
                report(ctx, found.message, "warning");
                return;
            }
            await showText("Pi Toggles explanation", service.explain(found.capability), ctx);
            return;
        }
        case "refresh":
            await service.refresh();
            report(ctx, "Pi Toggles catalog and facts refreshed.", "info");
            return;
        case "doctor":
            await showText("Pi Toggles doctor", doctorText(service), ctx);
            return;
        case "help":
            await showText("Pi Toggles help", commandHelp, ctx);
            return;
    }
}
