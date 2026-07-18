import { isAbsolute, relative } from "node:path";
import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import type { CapabilityKind, CapabilitySelector, DesiredState } from "./settings.ts";

export type ObservedState = "active" | "inactive" | "unavailable";

export type CapabilitySource = {
    readonly source: string;
    readonly scope: "user" | "project" | "temporary";
    readonly origin: "package" | "top-level";
    readonly path: string;
    readonly baseDir?: string;
};

export type Capability = {
    readonly id: string;
    readonly kind: CapabilityKind;
    readonly name: string;
    readonly description?: string;
    readonly searchText?: string;
    readonly source: CapabilitySource;
    readonly observedState: ObservedState;
    readonly supported: boolean;
    readonly protected: boolean;
};

const statesByKind: Readonly<Record<CapabilityKind, ReadonlySet<DesiredState>>> = {
    tool: new Set(["inherit", "on", "off", "lazy"]),
    skill: new Set(["inherit", "on", "name-only", "user-only", "off"]),
    command: new Set(["inherit", "on", "off"]),
    "system-fragment": new Set(["inherit", "on", "off"]),
};

function escapeIdPart(value: string): string {
    return value.replaceAll("%", "%25").replaceAll("|", "%7C");
}

export function normalizeSourceInfo(sourceInfo: SourceInfo): CapabilitySource {
    const normalizedPath =
        sourceInfo.baseDir !== undefined && isAbsolute(sourceInfo.path)
            ? relative(sourceInfo.baseDir, sourceInfo.path)
            : sourceInfo.path;

    return {
        source: sourceInfo.source,
        scope: sourceInfo.scope,
        origin: sourceInfo.origin,
        path: normalizedPath,
        ...(sourceInfo.baseDir === undefined ? {} : { baseDir: sourceInfo.baseDir }),
    };
}

export function createCapabilityId(
    kind: CapabilityKind,
    name: string,
    source: Pick<CapabilitySource, "source" | "path">,
): string {
    return [kind, source.source, source.path, name].map(escapeIdPart).join("|");
}

export function isDesiredStateAllowed(kind: CapabilityKind, state: DesiredState): boolean {
    return statesByKind[kind].has(state);
}

export function getDesiredStates(kind: CapabilityKind): readonly DesiredState[] {
    return [...statesByKind[kind]];
}

export function selectorMatches(selector: CapabilitySelector, capability: Capability): boolean {
    return (
        selector.kind === capability.kind &&
        (selector.name === undefined || selector.name === capability.name) &&
        (selector.source === undefined || selector.source === capability.source.source) &&
        (selector.path === undefined || selector.path === capability.source.path)
    );
}

export function isExactSelector(selector: CapabilitySelector): boolean {
    return (
        selector.name !== undefined &&
        (selector.source !== undefined || selector.path !== undefined)
    );
}

export function selectorKey(selector: CapabilitySelector): string {
    return JSON.stringify({
        kind: selector.kind,
        name: selector.name ?? null,
        source: selector.source ?? null,
        path: selector.path ?? null,
    });
}

export function selectorForCapability(capability: Capability): CapabilitySelector {
    return {
        kind: capability.kind,
        name: capability.name,
        source: capability.source.source,
        path: capability.source.path,
    };
}
