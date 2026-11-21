import { getCapabilities } from "@earendil-works/pi-tui";

type TerminalCapabilities = ReturnType<typeof getCapabilities>;

export type CapabilitiesProvider = {
    readonly getCapabilities: () => TerminalCapabilities;
};

export const defaultCapabilitiesProvider: CapabilitiesProvider = {
    getCapabilities,
};
