import { getCapabilities } from "@earendil-works/pi-tui";

type TerminalCapabilities = ReturnType<typeof getCapabilities>;

/** Supplies terminal capabilities to renderers through an explicit seam. */
export type CapabilitiesProvider = {
    readonly getCapabilities: () => TerminalCapabilities;
};

export const defaultCapabilitiesProvider: CapabilitiesProvider = {
    getCapabilities,
};
