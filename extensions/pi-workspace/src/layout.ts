import { HStack, ScrollView, Text, VStack, type Component } from "@earendil-works/pi-tui";
import { BackendRegistry } from "./backend-registry.ts";

export type WorkspaceSummary = {
    readonly cwd: string;
    readonly session: string;
    readonly leaf: string;
    readonly working: boolean;
};

export type SidebarView = { readonly component: Component; dispose(): void };
export type SidebarRegistration = { update(next: SidebarProvider): void; dispose(): void };

export type SidebarProvider = {
    readonly title: string;
    create(summary: () => WorkspaceSummary): { readonly component: Component; dispose(): void };
};

export type LayoutSettings = {
    readonly side: "off" | "left" | "right";
    readonly width: number;
    readonly minimumMainWidth: number;
};

export type WorkspaceLayoutSource = {
    readonly native: Component;
    readonly sidebar: Component;
    readonly settings: LayoutSettings;
};

export type WorkspaceLayout = {
    readonly component: Component;
    mainWidth(width: number): number;
    dispose(): void;
};

export type LayoutBackend = { create(source: WorkspaceLayoutSource): WorkspaceLayout };

class SummaryPanel extends Text {
    constructor(private readonly summary: () => WorkspaceSummary) {
        super("", 0, 0);
    }

    override render(width: number): string[] {
        const summary = this.summary();
        let activity = "Idle";
        if (summary.working) activity = "Working";
        this.setText(`${summary.session}\n${summary.cwd}\nLeaf ${summary.leaf}\n${activity}`);

        return super.render(width);
    }
}

const providerKey = Symbol.for("zigai.pi-workspace.sidebar-providers");

type ProviderState = {
    readonly entries: Map<string, { provider: SidebarProvider }[]>;
    readonly listeners: Set<() => void>;
};

type Providers = typeof globalThis & { [providerKey]?: ProviderState };

const providersShared: Providers = globalThis;
const sidebarProviders: ProviderState = providersShared[providerKey] ?? {
    entries: new Map(),
    listeners: new Set(),
};
providersShared[providerKey] = sidebarProviders;

function changeProviders(apply: () => void, restore: () => void): void {
    apply();

    const notified: (() => void)[] = [];

    try {
        for (const listener of sidebarProviders.listeners) {
            notified.push(listener);
            listener();
        }
    } catch (cause) {
        restore();

        const failures: unknown[] = [cause];
        for (const listener of notified.reverse()) {
            try {
                listener();
            } catch (failure) {
                failures.push(failure);
            }
        }

        if (failures.length > 1)
            throw new AggregateError(failures, "Sidebar change and restoration failed");

        throw cause;
    }
}

export function observeSidebarProviders(listener: () => void): () => void {
    sidebarProviders.listeners.add(listener);

    return () => {
        sidebarProviders.listeners.delete(listener);
    };
}

export function registerSidebarProvider(
    id: string,
    provider: SidebarProvider,
): SidebarRegistration {
    if (id.length === 0) throw new Error("Sidebar identity cannot be empty");

    const entries = sidebarProviders.entries.get(id) ?? [];
    const entry = { provider };

    changeProviders(
        () => {
            entries.push(entry);
            sidebarProviders.entries.set(id, entries);
        },
        () => {
            entries.pop();

            if (entries.length === 0) sidebarProviders.entries.delete(id);
        },
    );

    let disposed = false;

    return {
        update: (next) => {
            if (disposed) return;

            const previous = entry.provider;

            changeProviders(
                () => {
                    entry.provider = next;
                },
                () => {
                    entry.provider = previous;
                },
            );
        },
        dispose: () => {
            if (disposed) return;

            const index = entries.indexOf(entry);

            changeProviders(
                () => {
                    entries.splice(index, 1);

                    if (entries.length === 0) sidebarProviders.entries.delete(id);
                },
                () => {
                    entries.splice(index, 0, entry);
                    sidebarProviders.entries.set(id, entries);
                },
            );
            disposed = true;
        },
    };
}

export function createSidebar(summary: () => WorkspaceSummary): SidebarView {
    const views: { component: Component; dispose(): void }[] = [];
    const root = new VStack([new Text("Session", 0, 0), new SummaryPanel(summary)]);

    try {
        for (const entries of sidebarProviders.entries.values()) {
            const provider = entries.at(-1)?.provider;
            if (provider === undefined) continue;

            const view = provider.create(summary);
            views.push(view);
            root.addChild(new Text(provider.title, 0, 0));
            root.addChild(view.component);
        }
    } catch (cause) {
        for (const view of views.reverse()) view.dispose();

        throw cause;
    }

    let disposed = false;

    return {
        component: new ScrollView(root, {
            follow: "none",
            overscroll: "contain",
            scrollbar: "auto",
        }),
        dispose: () => {
            if (disposed) return;

            disposed = true;

            for (const view of views.reverse()) view.dispose();
        },
    };
}

function sideLayout(source: WorkspaceLayoutSource): WorkspaceLayout {
    const main = { component: source.native, grow: 1, minSize: 1 };
    const sidebar = {
        component: source.sidebar,
        basis: source.settings.width,
        shrink: 0,
        visible: (viewport: { width: number }) =>
            source.settings.side !== "off" &&
            viewport.width >= source.settings.width + source.settings.minimumMainWidth + 1,
    };
    let component: Component;
    if (source.settings.side === "left") component = new HStack([sidebar, main], { gap: 1 });
    else component = new HStack([main, sidebar], { gap: 1 });

    return {
        component,
        mainWidth: (width) => {
            if (
                source.settings.side === "off" ||
                width < source.settings.width + source.settings.minimumMainWidth + 1
            )
                return width;

            return width - source.settings.width - 1;
        },
        dispose(): void {},
    };
}

const registryKey = Symbol.for("zigai.pi-workspace.layout-backends");

type Shared = typeof globalThis & { [registryKey]?: BackendRegistry<LayoutBackend> };

const shared: Shared = globalThis;

const builtins: ReadonlyMap<string, LayoutBackend> = new Map([
    [
        "native",
        {
            create: (source) => ({
                component: source.native,
                mainWidth: (width) => width,
                dispose(): void {},
            }),
        },
    ],
    ["sidebar", { create: sideLayout }],
]);

export const layoutBackends = shared[registryKey] ?? new BackendRegistry(builtins, "native");
shared[registryKey] = layoutBackends;

export function registerLayoutBackend(
    name: string,
    backend: LayoutBackend,
): { update(next: LayoutBackend): void; dispose(): void } {
    return layoutBackends.register(name, backend);
}

export function selectLayoutBackend(name: string): void {
    layoutBackends.select(name);
}
