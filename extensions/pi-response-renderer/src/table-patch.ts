import { Markdown, styleText, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import {
    installKeyedLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
} from "@zigai/pi-extension-internals";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
    clearTableBoundaryLines,
    recordTableBoundaryLines,
    shouldHideFences,
} from "./markdown-rendering.ts";
import { tableRenderingState } from "./table-rendering.ts";
import type { ResponseRendererSettings } from "./settings.ts";

export type TableStyle = Pick<ResponseRendererSettings, "nativeTableBorderStyle"> & {
    accent?: (text: string) => string;
};

function dimNativeTableBorders(lines: string[]): string[] {
    const top = lines.at(0);
    if (top === undefined || !/^┌[─┬]+┐$/u.test(top)) return lines;

    const borders = new Set([...top.matchAll(/[┌┬┐]/gu)].map((match) => match.index));

    return lines.map((line) => {
        if (/^[┌├└][─┬┼┴]+[┐┤┘]$/u.test(line)) {
            return styleText(line, { dim: true }, "truecolor");
        }

        return line.replace(/│/gu, (border: string, offset: number) => {
            if (borders.has(visibleWidth(line.slice(0, offset)))) {
                return styleText(border, { dim: true }, "truecolor");
            }

            return border;
        });
    });
}

const tableSchema = Type.Object({
    header: Type.Array(Type.Object({ tokens: Type.Array(Type.Unknown()) })),
    rows: Type.Array(Type.Array(Type.Object({ tokens: Type.Array(Type.Unknown()) }))),
    align: Type.Array(
        Type.Union([
            Type.Literal("left"),
            Type.Literal("center"),
            Type.Literal("right"),
            Type.Null(),
        ]),
    ),
});

const hostSchema = Type.Object({
    render: Type.Function([Type.Number()], Type.Array(Type.String())),
    invalidate: Type.Function([], Type.Void()),
    renderTable: Type.Function(
        [
            Type.Unknown(),
            Type.Number(),
            Type.Optional(Type.String()),
            Type.Optional(Type.Unknown()),
        ],
        Type.Array(Type.String()),
    ),
    renderInlineTokens: Type.Function(
        [Type.Array(Type.Unknown()), Type.Optional(Type.Unknown())],
        Type.String(),
    ),
});

type TableHost = Static<typeof hostSchema>;

const TABLE_PATCH = Symbol.for("zigai.pi-response-renderer.table-patch");
const TABLE_CACHE_PATCH = Symbol.for("zigai.pi-response-renderer.table-cache-patch");
const TABLE_BOUNDARY_PATCH = Symbol.for("zigai.pi-response-renderer.table-boundary-patch");
const TABLE_INSTALLATIONS = Symbol.for("zigai.pi-response-renderer.table-installations");

type TableInstallation = {
    readonly owners: Map<symbol, TableStyle>;
    readonly patch: ReturnType<typeof createTablePatch>;
};

export function installTableRendering(settings: TableStyle) {
    const candidate: unknown = Markdown.prototype;
    if (!Value.Check(hostSchema, candidate)) {
        warnPiInternalPatchUnavailable("pi-response-renderer", "Markdown table methods");
        return undefined;
    }

    const host = candidate;
    const state: typeof globalThis & {
        [TABLE_INSTALLATIONS]?: WeakMap<TableHost, TableInstallation>;
    } = globalThis;
    const installations = (state[TABLE_INSTALLATIONS] ??= new WeakMap());
    let installation = installations.get(host);
    if (installation === undefined) {
        installation = { owners: new Map(), patch: createTablePatch(host, settings) };
        installations.set(host, installation);
    }

    const { owners, patch } = installation;
    const owner = Symbol();
    owners.set(owner, settings);
    patch.update(settings);

    let disposed = false;

    return {
        update(next: TableStyle): void {
            if (disposed) return;

            owners.delete(owner);
            owners.set(owner, next);
            patch.update(next);
        },
        dispose(): void {
            if (disposed) return;

            owners.delete(owner);

            const previous = [...owners.values()].at(-1);
            if (previous === undefined) {
                patch.dispose();
                installations.delete(host);
            } else {
                patch.update(previous);
            }

            disposed = true;
        },
    };
}

function createTablePatch(host: TableHost, settings: TableStyle) {
    const revisions = new WeakMap<TableHost, number>();
    const widths = new WeakMap<TableHost, number>();
    const accentSamples = new WeakMap<TableHost, string>();
    const affected = new WeakSet<TableHost>();
    const instances = new Set<WeakRef<TableHost>>();
    const collected = new FinalizationRegistry<WeakRef<TableHost>>((reference) => {
        instances.delete(reference);
    });
    const invalidate = (): void => {
        for (const reference of instances) {
            const instance = reference.deref();
            if (instance === undefined) instances.delete(reference);
            else instance.invalidate();
        }
    };

    const table = installKeyedLinkedMethodPatch(
        host,
        "renderTable",
        TABLE_PATCH,
        settings,
        (predecessor, policy) =>
            function (this: TableHost, token, width, nextTokenType, context) {
                const state = tableRenderingState();

                if (!shouldHideFences(this)) {
                    return predecessor.call(this, token, width, nextTokenType, context);
                }

                if (!affected.has(this)) {
                    affected.add(this);

                    const reference = new WeakRef(this);
                    instances.add(reference);
                    collected.register(this, reference, reference);
                }

                if (state.name === "native") {
                    const lines = predecessor.call(this, token, width, nextTokenType, context);
                    recordTableBoundaryLines(this, lines);

                    if (policy().nativeTableBorderStyle === "dim") {
                        return dimNativeTableBorders(lines);
                    }

                    return lines;
                }

                if (!Value.Check(tableSchema, token) || state.renderer === undefined) {
                    throw new Error("Incompatible Markdown table token or selected renderer");
                }

                const parsed = Value.Parse(tableSchema, token);
                const lines = state.renderer({
                    headers: parsed.header.map((cell) =>
                        this.renderInlineTokens(cell.tokens, context),
                    ),
                    rows: parsed.rows.map((row) =>
                        row.map((cell) => this.renderInlineTokens(cell.tokens, context)),
                    ),
                    align: parsed.align,
                    width,
                    header: (text) => {
                        const accent = policy().accent;
                        if (accent !== undefined) {
                            return styleText(accent(text), { bold: true }, "truecolor");
                        }
                        return styleText(text, { bold: true }, "truecolor");
                    },
                    rule: (text) => styleText(text, { fg: parseColor("#555555") }, "truecolor"),
                });

                recordTableBoundaryLines(this, lines);

                if (nextTokenType !== undefined && nextTokenType !== "space") return [...lines, ""];
                return lines;
            },
    );
    const boundaries = installKeyedLinkedMethodPatch(
        host,
        "invalidate",
        TABLE_BOUNDARY_PATCH,
        undefined,
        (predecessor) =>
            function (this: TableHost) {
                clearTableBoundaryLines(this);
                predecessor.call(this);
            },
    );
    const cache = installKeyedLinkedMethodPatch(
        host,
        "render",
        TABLE_CACHE_PATCH,
        undefined,
        (predecessor) =>
            function (this: TableHost, width) {
                const accent = settings.accent;
                const sample = accent?.("\u0000") ?? "";
                if (accentSamples.get(this) !== sample) {
                    this.invalidate();
                    accentSamples.set(this, sample);
                }
                const revision = tableRenderingState().revision;
                if (revisions.get(this) !== revision) {
                    this.invalidate();
                    revisions.set(this, revision);
                }

                if (widths.get(this) !== width) {
                    clearTableBoundaryLines(this);
                    widths.set(this, width);
                }

                return predecessor.call(this, width);
            },
    );

    return {
        update(next: TableStyle): void {
            settings = next;
            table.update(next);
            invalidate();
        },
        dispose(): void {
            invalidate();

            for (const reference of instances) collected.unregister(reference);
            instances.clear();
            cache.dispose();
            boundaries.dispose();
            table.dispose();
        },
    };
}
