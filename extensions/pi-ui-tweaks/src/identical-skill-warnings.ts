import {
    InteractiveMode,
    type LoadSkillsResult,
    type ResourceDiagnostic,
    type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
    installKeyedLinkedMethodPatch,
    installLinkedMethodPatch,
    reportExtensionDiagnostic,
} from "@zigai/pi-extension-internals";
import { identicalSkillBundles, skillComparisonBudget } from "./identical-skill-bundles.ts";

const PATCH = Symbol.for("zigai.pi-ui-tweaks.identical-skill-warnings-patch");

export type IdenticalSkillWarningsConfig = { readonly hideIdenticalSkillWarnings: boolean };
type Handle = { update(config: IdenticalSkillWarningsConfig): void; dispose(): void };
type SkillPresentationMode = { session: { resourceLoader: Pick<ResourceLoader, "getSkills"> } };

type ShowResourcesOptions = {
    force?: boolean;
    showDiagnosticsWhenQuiet?: boolean;

    extensions?: Pick<
        ReturnType<ResourceLoader["getExtensions"]>["extensions"][number],
        "path" | "sourceInfo"
    >[];
};

type ShowResources = (this: SkillPresentationMode, options?: ShowResourcesOptions) => void;
type ShowResourcesView = { showLoadedResources?: ShowResources };

function isObject(value: unknown): value is object {
    return typeof value === "object" && value !== null;
}

function isShowResourcesView(value: unknown): value is { showLoadedResources: ShowResources } {
    return (
        isObject(value) &&
        "showLoadedResources" in value &&
        typeof value.showLoadedResources === "function"
    );
}

function isSkillPresentationMode(value: unknown): value is SkillPresentationMode {
    if (!isObject(value)) return false;

    // SAFETY: Only the private loader method validated below is used by this adapter.
    const view = value as {
        session?: { resourceLoader?: Partial<Pick<ResourceLoader, "getSkills">> };
    };
    return typeof view.session?.resourceLoader?.getSkills === "function";
}

function isDiagnostic(value: unknown): value is ResourceDiagnostic {
    if (!isObject(value)) return false;

    // SAFETY: All diagnostic fields consumed by the filter are validated here.
    const view = value as Partial<ResourceDiagnostic>;
    const collision = view.collision;

    return (
        (view.type === "warning" || view.type === "error" || view.type === "collision") &&
        typeof view.message === "string" &&
        (collision === undefined ||
            (isObject(collision) &&
                typeof collision.resourceType === "string" &&
                typeof collision.winnerPath === "string" &&
                typeof collision.loserPath === "string"))
    );
}

function presentationSkills(result: LoadSkillsResult): LoadSkillsResult {
    // Future or malformed host results must pass through, not lose diagnostics.
    if (
        !isObject(result) ||
        !Array.isArray(result.diagnostics) ||
        !result.diagnostics.every(isDiagnostic)
    )
        return result;

    const budget = skillComparisonBudget();
    const diagnostics = result.diagnostics.filter((diagnostic) => {
        const collision = diagnostic.collision;
        if (diagnostic.type !== "collision" || collision?.resourceType !== "skill") return true;
        return !identicalSkillBundles(collision.winnerPath, collision.loserPath, budget);
    });
    if (diagnostics.length === result.diagnostics.length) return result;

    return { ...result, diagnostics };
}

function warn(reason: string): void {
    reportExtensionDiagnostic(
        `[pi-ui-tweaks] identical skill warning patch unavailable; Pi internals may have changed: ${reason}`,
    );
}

/** Filter only the synchronous startup presentation read, never the loader's stored diagnostics. */
export function installIdenticalSkillWarningsPatch(
    config: IdenticalSkillWarningsConfig,
    target?: ShowResourcesView | null,
): Handle {
    let candidate = target;
    if (candidate === undefined && isShowResourcesView(InteractiveMode.prototype))
        candidate = InteractiveMode.prototype;

    if (!isShowResourcesView(candidate)) {
        warn("missing showLoadedResources");

        return { update(): void {}, dispose(): void {} };
    }

    let warned = false;
    const warnOnce = (reason: string): void => {
        if (!warned) warn(reason);
        warned = true;
    };

    return installKeyedLinkedMethodPatch(
        candidate,
        "showLoadedResources",
        PATCH,
        config,
        (predecessor, policy) =>
            function (options): void {
                if (!policy().hideIdenticalSkillWarnings) return predecessor.call(this, options);

                if (!isSkillPresentationMode(this)) {
                    warnOnce("missing resourceLoader.getSkills");
                    return predecessor.call(this, options);
                }

                const loader = this.session.resourceLoader;
                let patch;
                try {
                    patch = installLinkedMethodPatch(
                        loader,
                        "getSkills",
                        (getSkills) =>
                            function (): LoadSkillsResult {
                                return presentationSkills(getSkills.call(this));
                            },
                    );
                } catch {
                    warnOnce("resourceLoader.getSkills is not patchable");
                    return predecessor.call(this, options);
                }

                try {
                    predecessor.call(this, options);
                } finally {
                    patch.dispose();
                }
            },
    );
}
