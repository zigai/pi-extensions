import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createListProvider, registerMention } from "@zigai/pi-mention-anything/api";

export default function (pi: ExtensionAPI): void {
    registerMention(pi, {
        id: "environments",
        configuration: () => ({ trigger: "env:", cache: true }),
        provider: () =>
            createListProvider(async () => [
                {
                    id: "staging",
                    label: "Staging",
                    segment: "staging",
                    selectable: true,
                    navigable: false,
                    replacement: "deployment environment staging",
                },
                {
                    id: "production",
                    label: "Production",
                    segment: "production",
                    selectable: true,
                    navigable: false,
                    replacement: "deployment environment production",
                },
            ]),
    });
}
