import {
    getCapabilities,
    resetCapabilitiesCache,
    type Component,
    type TUI,
} from "@earendil-works/pi-tui";

type TerminalHyperlinkContext = {
    readonly hasUI: boolean;

    readonly ui: {
        setWidget(key: string, content: ((tui: TUI) => Component) | undefined): void;
    };
};

const WIDGET_KEY = "pi-ui-tweaks-terminal-hyperlinks";

export function installTerminalHyperlinkRefresh(ctx: TerminalHyperlinkContext, enabled: boolean) {
    let tui: TUI | undefined;
    let interval: NodeJS.Timeout | undefined;

    function update(nextEnabled: boolean): void {
        if (
            !nextEnabled ||
            !ctx.hasUI ||
            ((process.env.TMUX === undefined || process.env.TMUX.length === 0) &&
                process.env.TERM?.startsWith("tmux") !== true)
        ) {
            if (interval) clearInterval(interval);
            interval = undefined;
            return;
        }

        if (!tui) {
            ctx.ui.setWidget(WIDGET_KEY, (instance) => {
                tui = instance;

                return { render: () => [], invalidate: () => {} };
            });
            ctx.ui.setWidget(WIDGET_KEY, undefined);
        }

        if (interval) return;

        interval = setInterval(() => {
            const previous = getCapabilities().hyperlinks;
            resetCapabilitiesCache();

            if (getCapabilities().hyperlinks !== previous) {
                tui?.invalidate();
                tui?.requestRender();
            }
        }, 1000);
        interval.unref();
    }

    update(enabled);

    return {
        update,
        dispose(): void {
            if (interval) clearInterval(interval);
            interval = undefined;
            tui = undefined;
        },
    };
}
