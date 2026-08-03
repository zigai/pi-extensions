import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

export type SharedCodexSettingItem = {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly currentValue: string;
    readonly values: readonly string[];
};

export type SharedCodexSettingsTabAction = {
    readonly afterClose?: () => Promise<void> | void;
};

export type SharedCodexSettingsTabSession = {
    readonly getItems: () => readonly SharedCodexSettingItem[];
    readonly getHeaderLines?: (theme: Theme) => readonly string[];
    readonly onChange: (
        id: string,
        value: string,
    ) => Promise<SharedCodexSettingsTabAction | void> | SharedCodexSettingsTabAction | void;
    readonly dispose?: () => Promise<void> | void;
};

export type SharedCodexSettingsTab = {
    readonly id: string;
    readonly label: string;
    readonly order?: number;
    readonly aliases?: readonly string[];
    readonly create: (ctx: ExtensionContext) => SharedCodexSettingsTabSession;
};

export type SharedCodexCommandContribution = {
    readonly commands: readonly string[];
    readonly handle: (command: string, ctx: ExtensionContext) => Promise<void> | void;
};

export type CodexIntegrationContribution = {
    readonly id: string;
    readonly settingsTab?: SharedCodexSettingsTab;
    readonly command?: SharedCodexCommandContribution;
};

type RegisteredValue<T> = {
    readonly token: symbol;
    readonly value: T;
};

type CodexIntegrationRegistry = {
    readonly version: 1;
    readonly hosts: Map<string, symbol>;
    readonly contributions: Map<string, RegisteredValue<CodexIntegrationContribution>>;
};

declare global {
    var __zigaiPiCodexIntegrationV1: CodexIntegrationRegistry | undefined;
}

const INTEGRATION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

export function registerCodexSettingsHost(id: string): () => void {
    validateIntegrationId(id);
    const token = Symbol(id);
    const registry = getRegistry();
    registry.hosts.set(id, token);
    return () => {
        if (registry.hosts.get(id) === token) registry.hosts.delete(id);
    };
}

export function hasCodexSettingsHost(): boolean {
    return getRegistry().hosts.size > 0;
}

export function registerCodexIntegration(contribution: CodexIntegrationContribution): () => void {
    validateIntegrationId(contribution.id);
    if (contribution.settingsTab !== undefined) {
        validateIntegrationId(contribution.settingsTab.id);
    }
    const token = Symbol(contribution.id);
    const registry = getRegistry();
    registry.contributions.set(contribution.id, { token, value: contribution });
    return () => {
        if (registry.contributions.get(contribution.id)?.token === token) {
            registry.contributions.delete(contribution.id);
        }
    };
}

export function getCodexSettingsTabs(): readonly SharedCodexSettingsTab[] {
    return getContributions()
        .flatMap((contribution) =>
            contribution.settingsTab === undefined ? [] : [contribution.settingsTab],
        )
        .sort(
            (left, right) =>
                (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id),
        );
}

export function getCodexCommandContributions(): readonly SharedCodexCommandContribution[] {
    return getContributions().flatMap((contribution) =>
        contribution.command === undefined ? [] : [contribution.command],
    );
}

function getContributions(): CodexIntegrationContribution[] {
    return [...getRegistry().contributions.values()]
        .map(({ value }) => value)
        .sort((left, right) => left.id.localeCompare(right.id));
}

function getRegistry(): CodexIntegrationRegistry {
    globalThis.__zigaiPiCodexIntegrationV1 ??= {
        version: 1,
        hosts: new Map(),
        contributions: new Map(),
    };
    return globalThis.__zigaiPiCodexIntegrationV1;
}

function validateIntegrationId(id: string): void {
    if (!INTEGRATION_ID_PATTERN.test(id)) {
        throw new Error(`Invalid Codex integration id: ${id}`);
    }
}
