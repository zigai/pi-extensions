import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import type { ExtensionActivationProposal } from "./activation-coordination.ts";
import { buildCapabilityCatalog, LAZY_SEARCH_TOOL_NAME } from "./capability-catalog.ts";
import {
    createCapabilityId,
    isDesiredStateAllowed,
    selectorForCapability,
    selectorKey,
    selectorMatches,
    type Capability,
} from "./capability.ts";
import {
    createPolicyConfiguration,
    mergeProfiles,
    mergePromptFragments,
    type PolicyConfiguration,
    type PolicyScope,
    type SessionPolicy,
} from "./capability-policy.ts";
import {
    ContextFacts,
    type ClearContextInput,
    type RegisterContextKeyInput,
    type SetContextInput,
} from "./context-facts.ts";
import { getReferencedFacts } from "./condition.ts";
import { decideToolInvocation, rankLazyTools } from "./lazy-tool-search.ts";
import { appendActivePromptFragments } from "./prompt-fragments.ts";
import { applySkillPolicyToPrompt, decideSkillInvocation } from "./skill-policy.ts";
import {
    resolveCapabilityPolicy,
    type DecisionTrace,
    type EffectiveCapability,
    type PolicyPlan,
} from "./resolve-capability-policy.ts";
import {
    persistSessionPolicy,
    restoreSessionPolicy,
    updateSessionActiveProfile,
    updateSessionOverrides,
} from "./session-policy.ts";
import { SettingsStore, type SettingsWriteResult } from "./settings-store.ts";
import type { DesiredState, PolicyDecision } from "./settings.ts";

export type MutationResult =
    | { readonly status: "applied" }
    | { readonly status: "blocked" | "invalid" | "failed"; readonly message: string };

export type LazyActivationResult = {
    readonly matches: readonly string[];
    readonly added: readonly string[];
};

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    return left.size === right.size && [...left].every((value) => right.has(value));
}

function writeResultToMutation(result: SettingsWriteResult): MutationResult {
    return result.status === "saved"
        ? { status: "applied" }
        : { status: result.status, message: result.message };
}

function formatDecisionTraceSource(trace: DecisionTrace): string {
    if (trace.origin === "extension-proposal") return `extension proposal ${trace.source}`;
    if (trace.origin === "override") return `${trace.scope} override`;
    if (trace.origin === "profile") return `${trace.scope} profile ${trace.source}`;
    if (trace.origin === "rule-profile") return `${trace.scope} rule profile ${trace.source}`;
    return `${trace.scope} rule ${trace.source}`;
}

export class TogglesService {
    readonly #settingsStore: SettingsStore;
    readonly #facts: ContextFacts;
    readonly #inheritedToolState = new Map<string, boolean>();
    readonly #lazyActivated = new Set<string>();
    readonly #extensionActivationProposals = new Map<string, ExtensionActivationProposal>();
    readonly #runtimeDiagnostics: string[] = [];
    #diagnosticsTruncated = false;
    #sessionPolicy: SessionPolicy;
    #sessionDiagnostics: readonly string[];
    #configuration: PolicyConfiguration;
    #catalog: readonly Capability[] = [];
    #skills: readonly Skill[] | undefined;
    #plan: PolicyPlan = {
        capabilities: [],
        activeProfiles: new Set(),
        activePromptFragments: [],
        diagnostics: [],
    };
    #reconcileTail: Promise<void> = Promise.resolve();
    #reconcilePending: Promise<void> | undefined;
    #reconcileDirty = false;
    #disposed = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly ctx: ExtensionContext,
    ) {
        this.#settingsStore = new SettingsStore(ctx);
        const restored = restoreSessionPolicy(ctx);
        this.#sessionPolicy = restored.policy;
        this.#sessionDiagnostics = restored.diagnostics;
        this.#facts = new ContextFacts(ctx.cwd, ctx.isProjectTrusted());
        this.#configuration = this.createConfiguration();
        this.updateStaticFacts();
        this.refreshCatalogAndPlan();
    }

    get catalog(): readonly Capability[] {
        return this.#catalog;
    }

    get plan(): PolicyPlan {
        return this.#plan;
    }

    get configuration(): PolicyConfiguration {
        return this.#configuration;
    }

    get lazyToolLimit(): number {
        return this.#configuration.defaults.lazyToolLimit;
    }

    get activationCoordinationEnabled(): boolean {
        return this.#configuration.enabled;
    }

    getProfileNames(scope: PolicyScope): readonly string[] {
        const profiles =
            scope === "global"
                ? this.#configuration.global.profiles
                : mergeProfiles(this.#configuration);
        return Object.keys(profiles).sort();
    }

    getActiveProfile(scope: PolicyScope): string | undefined {
        return scope === "session"
            ? this.#configuration.session.activeProfile
            : scope === "project"
              ? this.#configuration.project.activeProfile
              : this.#configuration.global.activeProfile;
    }

    get diagnostics(): readonly string[] {
        const diagnostics = [
            ...new Set([
                ...this.#settingsStore.snapshot.diagnostics,
                ...this.#sessionDiagnostics,
                ...this.#facts.diagnostics,
                ...this.#plan.diagnostics,
                ...this.#runtimeDiagnostics,
            ]),
        ];
        return this.#diagnosticsTruncated
            ? [
                  ...diagnostics,
                  "Additional runtime diagnostics were omitted after the 100-item limit.",
              ]
            : diagnostics;
    }

    async initialize(): Promise<void> {
        await this.refreshGitFacts();
        await this.reconcile();
    }

    acceptExtensionActivationProposal(proposal: ExtensionActivationProposal): boolean {
        if (
            this.#disposed ||
            proposal.sessionId !== this.ctx.sessionManager.getSessionId() ||
            !this.activationCoordinationEnabled
        ) {
            return false;
        }
        this.#extensionActivationProposals.set(proposal.owner, proposal);
        this.refreshCatalogAndPlan();
        // Reconciliation owns its rejection path and is retained by #reconcileTail.
        void this.reconcile();
        return true;
    }

    clearExtensionActivationProposal(owner: string, sessionId: string): boolean {
        if (
            this.#disposed ||
            sessionId !== this.ctx.sessionManager.getSessionId() ||
            !this.#extensionActivationProposals.delete(owner)
        ) {
            return false;
        }
        this.refreshCatalogAndPlan();
        // Reconciliation owns its rejection path and is retained by #reconcileTail.
        void this.reconcile();
        return true;
    }

    async settleActivation(): Promise<void> {
        await this.#reconcileTail;
        if (this.#reconcilePending !== undefined) {
            await this.#reconcilePending;
        }
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        const available = new Set(this.pi.getAllTools().map((tool) => tool.name));
        const current = new Set(this.pi.getActiveTools());
        const restored = new Set(current);
        for (const [name, active] of this.#inheritedToolState) {
            if (name === LAZY_SEARCH_TOOL_NAME || !available.has(name)) {
                continue;
            }
            if (active) {
                restored.add(name);
            } else {
                restored.delete(name);
            }
        }
        if (!sameStringSet(current, restored)) {
            this.pi.setActiveTools([...restored]);
        }
        this.#inheritedToolState.clear();
        this.#lazyActivated.clear();
        this.#extensionActivationProposals.clear();
        if (this.ctx.mode === "tui") {
            this.ctx.ui.setStatus("pi-toggles", undefined);
        }
    }

    async refresh(prompt?: string): Promise<void> {
        if (prompt !== undefined) {
            this.#facts.set("prompt.text", prompt);
        }
        this.updateStaticFacts();
        await this.refreshGitFacts();
        this.refreshCatalogAndPlan();
        await this.reconcile();
    }

    async refreshAfterTurn(): Promise<void> {
        await this.refreshGitFacts();
        this.refreshCatalogAndPlan();
        await this.reconcile();
    }

    registerContextKey(input: RegisterContextKeyInput): void {
        this.#facts.registerContextKey(input);
        this.refreshCatalogAndPlan();
    }

    addDiagnostic(message: string): void {
        this.recordDiagnostics(message);
        this.updateStatus();
    }

    setContext(input: SetContextInput): void {
        this.#facts.setContext(input);
        this.refreshCatalogAndPlan();
        void this.reconcile();
    }

    clearContext(input: ClearContextInput): void {
        this.#facts.clearContext(input);
        this.refreshCatalogAndPlan();
        void this.reconcile();
    }

    findCapability(
        reference: string,
    ):
        | { readonly status: "found"; readonly capability: Capability }
        | { readonly status: "missing"; readonly message: string }
        | { readonly status: "ambiguous"; readonly message: string } {
        const exact = this.#catalog.find((capability) => capability.id === reference);
        if (exact !== undefined) {
            return { status: "found", capability: exact };
        }
        const normalized = reference.replace(/^\//, "");
        const matches = this.#catalog.filter(
            (capability) =>
                capability.name === normalized ||
                `${capability.kind}:${capability.name}` === normalized,
        );
        if (matches.length === 0) {
            return { status: "missing", message: `No capability matches ${reference}.` };
        }
        if (matches.length > 1) {
            return {
                status: "ambiguous",
                message: `Capability ${reference} is ambiguous: ${matches.map((match) => match.id).join(", ")}.`,
            };
        }
        const capability = matches[0];
        return capability === undefined
            ? { status: "missing", message: `No capability matches ${reference}.` }
            : { status: "found", capability };
    }

    getScopedState(capability: Capability, scope: PolicyScope): DesiredState {
        const decisions =
            scope === "session"
                ? this.#sessionPolicy.overrides
                : scope === "project"
                  ? this.#configuration.project.overrides
                  : this.#configuration.global.overrides;
        const matching = decisions.filter((decision) =>
            selectorMatches(decision.target, capability),
        );
        for (let index = matching.length - 1; index >= 0; index -= 1) {
            const decision = matching[index];
            if (decision !== undefined && decision.state !== "inherit") {
                return decision.state;
            }
        }
        return "inherit";
    }

    async setDecisions(
        scope: PolicyScope,
        decisions: readonly PolicyDecision[],
    ): Promise<MutationResult> {
        if (
            decisions.some(
                (decision) =>
                    decision.target.kind === "command" &&
                    decision.target.name === "toggles" &&
                    decision.state !== "inherit",
            )
        ) {
            return { status: "blocked", message: "The /toggles recovery command is protected." };
        }
        const normalizedDecisions = this.normalizeDecisionUpdates(scope, decisions);
        if (scope === "session") {
            this.#sessionPolicy = updateSessionOverrides(this.#sessionPolicy, normalizedDecisions);
            persistSessionPolicy(this.pi, this.#sessionPolicy);
            this.#configuration = this.createConfiguration();
            this.refreshCatalogAndPlan();
            await this.reconcile();
            return { status: "applied" };
        }

        const result = await this.#settingsStore.saveOverrides(scope, normalizedDecisions);
        if (result.status !== "saved") {
            return writeResultToMutation(result);
        }
        this.#configuration = this.createConfiguration();
        this.refreshCatalogAndPlan();
        await this.reconcile();
        return { status: "applied" };
    }

    private normalizeDecisionUpdates(
        scope: PolicyScope,
        decisions: readonly PolicyDecision[],
    ): readonly PolicyDecision[] {
        const current =
            scope === "session"
                ? this.#sessionPolicy.overrides
                : scope === "project"
                  ? this.#configuration.project.overrides
                  : this.#configuration.global.overrides;
        const updates = new Map<string, PolicyDecision>();
        for (const decision of decisions) {
            const capabilities = this.#catalog.filter((capability) =>
                selectorMatches(decision.target, capability),
            );
            for (const capability of capabilities) {
                for (const existing of current) {
                    if (selectorMatches(existing.target, capability)) {
                        updates.set(selectorKey(existing.target), {
                            target: existing.target,
                            state: "inherit",
                        });
                    }
                }
            }
            if (decision.state !== "inherit") {
                updates.set(selectorKey(decision.target), decision);
            }
        }
        return [...updates.values()];
    }

    async setCapabilityState(
        scope: PolicyScope,
        capability: Capability,
        state: DesiredState,
    ): Promise<MutationResult> {
        if (!isDesiredStateAllowed(capability.kind, state)) {
            return { status: "invalid", message: `${state} is not valid for ${capability.kind}.` };
        }
        if (!capability.supported && state !== "inherit") {
            return {
                status: "blocked",
                message: `Pi does not expose runtime ${capability.kind} control for ${capability.id}.`,
            };
        }
        if (capability.protected && state === "off") {
            return {
                status: "blocked",
                message: `${capability.id} is a protected recovery capability.`,
            };
        }
        return this.setDecisions(scope, [{ target: selectorForCapability(capability), state }]);
    }

    wouldLeaveNoActiveModelTools(
        scope: PolicyScope,
        decisions: readonly PolicyDecision[],
        activeProfile: string | undefined,
    ): boolean {
        const normalized = this.normalizeDecisionUpdates(scope, decisions);
        const current =
            scope === "session"
                ? this.#configuration.session.overrides
                : scope === "project"
                  ? this.#configuration.project.overrides
                  : this.#configuration.global.overrides;
        const overrides = new Map(
            current.map((decision) => [selectorKey(decision.target), decision]),
        );
        for (const decision of normalized) {
            const key = selectorKey(decision.target);
            if (decision.state === "inherit") {
                overrides.delete(key);
            } else {
                overrides.set(key, decision);
            }
        }
        const nextOverrides = [...overrides.values()];
        const session = {
            overrides: scope === "session" ? nextOverrides : this.#configuration.session.overrides,
            ...(scope === "session"
                ? activeProfile === undefined
                    ? {}
                    : { activeProfile }
                : this.#configuration.session.activeProfile === undefined
                  ? {}
                  : { activeProfile: this.#configuration.session.activeProfile }),
        };
        const project = {
            ...this.#configuration.project,
            ...(scope === "project"
                ? { overrides: nextOverrides }
                : { overrides: this.#configuration.project.overrides }),
        };
        if (scope === "project") {
            if (activeProfile === undefined) {
                delete project.activeProfile;
            } else {
                project.activeProfile = activeProfile;
            }
        }
        const global = {
            ...this.#configuration.global,
            ...(scope === "global"
                ? { overrides: nextOverrides }
                : { overrides: this.#configuration.global.overrides }),
        };
        if (scope === "global") {
            if (activeProfile === undefined) {
                delete global.activeProfile;
            } else {
                global.activeProfile = activeProfile;
            }
        }
        const configuration: PolicyConfiguration =
            scope === "session"
                ? {
                      ...this.#configuration,
                      session,
                  }
                : scope === "project"
                  ? {
                        ...this.#configuration,
                        project,
                    }
                  : {
                        ...this.#configuration,
                        global,
                    };
        const plan = resolveCapabilityPolicy(
            this.#catalog,
            configuration,
            this.#facts.resolve,
            this.extensionActivationProposals(),
        );
        const active = new Set(this.pi.getActiveTools());
        for (const entry of plan.capabilities) {
            if (entry.capability.kind !== "tool") {
                continue;
            }
            if (entry.effectiveState === "active") {
                active.add(entry.capability.name);
            } else if (entry.effectiveState === "inactive") {
                active.delete(entry.capability.name);
            } else if (entry.effectiveState === "lazy") {
                if (this.#lazyActivated.has(entry.capability.name)) {
                    active.add(entry.capability.name);
                } else {
                    active.delete(entry.capability.name);
                }
            }
        }
        active.delete(LAZY_SEARCH_TOOL_NAME);
        return active.size === 0;
    }

    async clearScope(scope: PolicyScope): Promise<MutationResult> {
        if (scope === "session") {
            this.#sessionPolicy = { overrides: [] };
            persistSessionPolicy(this.pi, this.#sessionPolicy);
        } else {
            const result = await this.#settingsStore.clearPolicy(scope);
            if (result.status !== "saved") {
                return writeResultToMutation(result);
            }
        }
        this.#configuration = this.createConfiguration();
        this.updateProfileFact();
        this.refreshCatalogAndPlan();
        await this.reconcile();
        return { status: "applied" };
    }

    getEffectiveCapability(capability: Capability): EffectiveCapability | undefined {
        return this.#plan.capabilities.find((entry) => entry.capability.id === capability.id);
    }

    async setActiveProfile(
        scope: PolicyScope,
        profile: string | undefined,
    ): Promise<MutationResult> {
        const profiles =
            scope === "global"
                ? this.#configuration.global.profiles
                : mergeProfiles(this.#configuration);
        if (profile !== undefined && profiles[profile] === undefined) {
            return { status: "invalid", message: `Profile ${profile} is not defined.` };
        }
        if (scope === "session") {
            this.#sessionPolicy = updateSessionActiveProfile(this.#sessionPolicy, profile);
            persistSessionPolicy(this.pi, this.#sessionPolicy);
        } else {
            const result = await this.#settingsStore.saveActiveProfile(scope, profile);
            if (result.status !== "saved") {
                return writeResultToMutation(result);
            }
        }
        this.#configuration = this.createConfiguration();
        this.updateProfileFact();
        this.refreshCatalogAndPlan();
        await this.reconcile();
        return { status: "applied" };
    }

    async applyPanelPolicy(
        scope: PolicyScope,
        decisions: readonly PolicyDecision[],
        activeProfile: string | undefined,
    ): Promise<MutationResult> {
        const profiles =
            scope === "global"
                ? this.#configuration.global.profiles
                : mergeProfiles(this.#configuration);
        if (
            activeProfile !== undefined &&
            profiles[activeProfile] === undefined &&
            activeProfile !== this.getActiveProfile(scope)
        ) {
            return { status: "invalid", message: `Profile ${activeProfile} is not defined.` };
        }
        const normalized = this.normalizeDecisionUpdates(scope, decisions);
        if (scope === "session") {
            this.#sessionPolicy = updateSessionActiveProfile(
                updateSessionOverrides(this.#sessionPolicy, normalized),
                activeProfile,
            );
            persistSessionPolicy(this.pi, this.#sessionPolicy);
        } else {
            const result = await this.#settingsStore.savePolicy(scope, normalized, activeProfile);
            if (result.status !== "saved") {
                return writeResultToMutation(result);
            }
        }
        this.#configuration = this.createConfiguration();
        this.updateProfileFact();
        this.refreshCatalogAndPlan();
        await this.reconcile();
        return { status: "applied" };
    }

    async activateLazy(query: string, limit: number): Promise<LazyActivationResult> {
        const matches = rankLazyTools(this.#plan, query, limit);
        const added = matches.filter((name) => !this.#lazyActivated.has(name));
        for (const name of added) {
            this.#lazyActivated.add(name);
        }
        await this.reconcile();
        return { matches, added };
    }

    canInvokeTool(
        name: string,
    ): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
        return decideToolInvocation(this.#plan, name, this.#lazyActivated);
    }

    canInvokeSkill(text: string): ReturnType<typeof decideSkillInvocation> {
        return decideSkillInvocation(this.#plan, text);
    }

    explain(capability: Capability): string {
        const entry = this.#plan.capabilities.find(
            (candidate) => candidate.capability.id === capability.id,
        );
        if (entry === undefined) {
            return `Capability ${capability.id} is not in the current policy plan.`;
        }
        const lines = [
            `Capability: ${capability.id}`,
            `Observed: ${capability.observedState}`,
            `Desired: ${entry.desiredState}`,
            `Effective: ${entry.effectiveState}`,
            `Supported: ${capability.supported ? "yes" : "no"}`,
            "",
            "Decision trace:",
        ];
        if (entry.trace.length === 0) {
            lines.push("  inherited from Pi runtime");
        } else {
            for (const trace of entry.trace.slice(0, 100)) {
                lines.push(
                    `  ${formatDecisionTraceSource(trace)}: ${trace.state}${trace.selected ? " <- winner" : ` (${trace.reason ?? "shadowed"})`}`,
                );
            }
            if (entry.trace.length > 100) {
                lines.push(`  … ${entry.trace.length - 100} additional decisions omitted.`);
            }
        }
        return lines.join("\n");
    }

    async buildSystemPrompt(basePrompt: string, skills: readonly Skill[]): Promise<string> {
        this.#skills = [...skills];
        this.refreshCatalogAndPlan();
        const skillFilteredPrompt = applySkillPolicyToPrompt(basePrompt, skills, this.#plan);
        if (this.#plan.activePromptFragments.length === 0) {
            return skillFilteredPrompt;
        }
        const snapshot = this.#settingsStore.snapshot;
        const result = await appendActivePromptFragments(
            skillFilteredPrompt,
            this.#plan.activePromptFragments,
            {
                cwd: this.ctx.cwd,
                projectTrusted: this.ctx.isProjectTrusted(),
                globalConfigPath: snapshot.loaded.globalConfigPath,
                ...(snapshot.loaded.projectConfigPath === undefined
                    ? {}
                    : { projectConfigPath: snapshot.loaded.projectConfigPath }),
            },
        );
        this.recordDiagnostics(...result.diagnostics);
        return result.prompt;
    }

    statusText(): string | undefined {
        const changed = this.#plan.capabilities.filter(
            (entry) => entry.desiredState !== "inherit" && entry.effectiveState !== "unsupported",
        );
        const lazyCount = changed.filter((entry) => entry.effectiveState === "lazy").length;
        const offCount = changed.filter((entry) => entry.effectiveState === "inactive").length;
        const tailoredSkillCount = changed.filter(
            (entry) => entry.effectiveState === "name-only" || entry.effectiveState === "user-only",
        ).length;
        if (this.diagnostics.length > 0) {
            return `toggles: ${this.diagnostics.length} diagnostic${this.diagnostics.length === 1 ? "" : "s"}`;
        }
        if (changed.length === 0) {
            return undefined;
        }
        return `toggles: ${offCount} off, ${lazyCount} lazy, ${tailoredSkillCount} tailored`;
    }

    updateStatus(): void {
        if (this.ctx.mode !== "tui") {
            return;
        }
        if (!this.#configuration.defaults.showStatus) {
            this.ctx.ui.setStatus("pi-toggles", undefined);
            return;
        }
        this.ctx.ui.setStatus("pi-toggles", this.statusText());
    }

    private createConfiguration(): PolicyConfiguration {
        const snapshot = this.#settingsStore.snapshot;
        return createPolicyConfiguration({
            resolved: snapshot.resolved,
            globalDocument: snapshot.globalDocument,
            projectDocument: snapshot.projectDocument,
            session: this.#sessionPolicy,
        });
    }

    private updateStaticFacts(): void {
        this.#facts.updateProject(this.ctx.cwd, this.ctx.isProjectTrusted());
        this.#facts.set("session.mode", this.ctx.mode);
        this.#facts.set("session.name", this.pi.getSessionName());
        this.#facts.set(
            "session.persisted",
            this.ctx.sessionManager.getSessionFile() !== undefined,
        );
        this.#facts.set("os.platform", process.platform);
        this.#facts.set("model.provider", this.ctx.model?.provider);
        this.#facts.set("model.id", this.ctx.model?.id);
        this.#facts.set("model.reasoning", this.ctx.model?.reasoning);
        this.#facts.set("thinking.level", this.pi.getThinkingLevel());
        this.updateProfileFact();
    }

    private updateProfileFact(): void {
        const activeProfile =
            this.#sessionPolicy.activeProfile ??
            this.#configuration.project.activeProfile ??
            this.#configuration.global.activeProfile;
        this.#facts.set("profile.active", activeProfile);
    }

    private async refreshGitFacts(): Promise<void> {
        const referencedFacts = this.getReferencedFacts();
        if (![...referencedFacts].some((fact) => fact.startsWith("project.git"))) {
            this.#facts.set("project.gitRepository", undefined);
            this.#facts.set("project.gitBranch", undefined);
            this.#facts.set("project.gitDirty", undefined);
            return;
        }
        if (!this.ctx.isProjectTrusted()) {
            this.#facts.set("project.gitRepository", undefined);
            this.#facts.set("project.gitBranch", undefined);
            this.#facts.set("project.gitDirty", undefined);
            return;
        }
        const repository = await this.pi.exec("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd: this.ctx.cwd,
            timeout: 2_000,
        });
        const isRepository = repository.code === 0 && repository.stdout.trim() === "true";
        this.#facts.set("project.gitRepository", isRepository);
        if (!isRepository) {
            this.#facts.set("project.gitBranch", undefined);
            this.#facts.set("project.gitDirty", undefined);
            return;
        }
        const [branch, status] = await Promise.all([
            this.pi.exec("git", ["branch", "--show-current"], {
                cwd: this.ctx.cwd,
                timeout: 2_000,
            }),
            this.pi.exec("git", ["status", "--porcelain"], { cwd: this.ctx.cwd, timeout: 2_000 }),
        ]);
        this.#facts.set("project.gitBranch", branch.code === 0 ? branch.stdout.trim() : undefined);
        this.#facts.set(
            "project.gitDirty",
            status.code === 0 ? status.stdout.trim().length > 0 : undefined,
        );
    }

    private getReferencedFacts(): ReadonlySet<string> {
        const facts = new Set<string>();
        for (const layer of [this.#configuration.global, this.#configuration.project]) {
            for (const rule of layer.rules) {
                for (const fact of getReferencedFacts(rule.when)) {
                    facts.add(fact);
                }
            }
            for (const fragment of layer.promptFragments) {
                if (fragment.when === undefined) {
                    continue;
                }
                for (const fact of getReferencedFacts(fragment.when)) {
                    facts.add(fact);
                }
            }
        }
        return facts;
    }

    private refreshCatalogAndPlan(): void {
        const fragments = mergePromptFragments(this.#configuration);
        const discovered = buildCapabilityCatalog({
            tools: this.pi.getAllTools(),
            activeToolNames: new Set(this.pi.getActiveTools()),
            commands: this.pi.getCommands(),
            ...(this.#skills === undefined ? {} : { skills: this.#skills }),
            promptFragments: fragments,
        });
        this.#catalog = this.addUnavailableOverrides(discovered);
        this.#plan = resolveCapabilityPolicy(
            this.#catalog,
            this.#configuration,
            this.#facts.resolve,
            this.extensionActivationProposals(),
        );
        this.updateStatus();
    }

    private addUnavailableOverrides(discovered: readonly Capability[]): readonly Capability[] {
        const scopedDecisions = [
            ...this.extensionActivationProposals().flatMap((proposal) =>
                proposal.decisions.map((decision) => ({
                    decision,
                    scope: "temporary" as const,
                })),
            ),
            ...this.#configuration.session.overrides.map((decision) => ({
                decision,
                scope: "temporary" as const,
            })),
            ...this.#configuration.project.overrides.map((decision) => ({
                decision,
                scope: "project" as const,
            })),
            ...this.#configuration.global.overrides.map((decision) => ({
                decision,
                scope: "user" as const,
            })),
        ];
        const unavailable: Capability[] = [];
        for (const { decision, scope } of scopedDecisions) {
            if (discovered.some((capability) => selectorMatches(decision.target, capability))) {
                continue;
            }
            const name = decision.target.name;
            if (name === undefined) {
                continue;
            }
            const source = {
                source: decision.target.source ?? "unresolved",
                scope,
                origin: "top-level" as const,
                path: decision.target.path ?? `<unresolved:${name}>`,
            };
            const id = createCapabilityId(decision.target.kind, name, source);
            if (unavailable.some((capability) => capability.id === id)) {
                continue;
            }
            unavailable.push({
                id,
                kind: decision.target.kind,
                name,
                description: "Policy target is unavailable in the current Pi runtime",
                source,
                observedState: "unavailable",
                supported: false,
                protected: false,
            });
        }
        return [...discovered, ...unavailable].sort((left, right) =>
            `${left.kind}:${left.name}:${left.source.source}`.localeCompare(
                `${right.kind}:${right.name}:${right.source.source}`,
            ),
        );
    }

    private extensionActivationProposals(): readonly ExtensionActivationProposal[] {
        return [...this.#extensionActivationProposals.values()].sort((left, right) =>
            left.owner.localeCompare(right.owner),
        );
    }

    private reconcile(): Promise<void> {
        this.#reconcileDirty = true;
        if (this.#reconcilePending !== undefined) {
            return this.#reconcilePending;
        }
        const operation = this.#reconcileTail.then(async () => {
            while (this.#reconcileDirty && !this.#disposed) {
                this.#reconcileDirty = false;
                await this.applyToolPlan();
                this.refreshCatalogAndPlan();
            }
        });
        const handled = operation.catch((cause: unknown) => {
            this.recordDiagnostics(
                `Reconciliation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
        });
        const pending = handled.finally(() => {
            if (this.#reconcilePending === pending) {
                this.#reconcilePending = undefined;
            }
        });
        this.#reconcilePending = pending;
        this.#reconcileTail = pending;
        return pending;
    }

    private async applyToolPlan(): Promise<void> {
        const current = new Set(this.pi.getActiveTools());
        const desired = new Set(current);
        const toolEntries = this.#plan.capabilities.filter(
            (entry): entry is EffectiveCapability & { capability: Capability & { kind: "tool" } } =>
                entry.capability.kind === "tool",
        );
        const lazyExists = toolEntries.some((entry) => entry.effectiveState === "lazy");

        for (const entry of toolEntries) {
            const name = entry.capability.name;
            const managed = entry.desiredState !== "inherit" || name === LAZY_SEARCH_TOOL_NAME;
            if (!managed) {
                const inherited = this.#inheritedToolState.get(name);
                if (inherited !== undefined) {
                    if (inherited) {
                        desired.add(name);
                    } else {
                        desired.delete(name);
                    }
                    this.#inheritedToolState.delete(name);
                }
                continue;
            }
            if (!this.#inheritedToolState.has(name)) {
                this.#inheritedToolState.set(name, current.has(name));
            }

            if (name === LAZY_SEARCH_TOOL_NAME) {
                if (lazyExists) {
                    desired.add(name);
                } else {
                    desired.delete(name);
                }
                continue;
            }
            if (entry.effectiveState === "active") {
                desired.add(name);
            } else if (entry.effectiveState === "inactive") {
                desired.delete(name);
                this.#lazyActivated.delete(name);
            } else if (entry.effectiveState === "lazy") {
                if (this.#lazyActivated.has(name)) {
                    desired.add(name);
                } else {
                    desired.delete(name);
                }
            }
        }

        if (!sameStringSet(current, desired)) {
            this.pi.setActiveTools([...desired]);
        }
        const observed = new Set(this.pi.getActiveTools());
        if (!sameStringSet(observed, desired)) {
            this.recordDiagnostics(
                `Active tool drift after reconciliation. Desired: ${[...desired].sort().join(", ")}; observed: ${[...observed].sort().join(", ")}.`,
            );
        }
    }

    private recordDiagnostics(...messages: readonly string[]): void {
        for (const message of messages) {
            if (this.#runtimeDiagnostics.includes(message)) {
                continue;
            }
            if (this.#runtimeDiagnostics.length >= 100) {
                this.#diagnosticsTruncated = true;
                return;
            }
            this.#runtimeDiagnostics.push(message);
        }
    }
}
