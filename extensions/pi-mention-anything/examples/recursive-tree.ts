import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createListProvider,
    registerMention,
    type Candidate,
} from "@zigai/pi-mention-anything/api";

/** A synthetic recursive tree: every branch can be selected or explored another level. */
export default function (pi: ExtensionAPI): void {
    registerMention(pi, {
        id: "tree",
        configuration: () => ({ trigger: "tree:", separator: ":", cache: true }),
        provider: () =>
            createListProvider(async (request) => {
                const parent = request.path.map((item) => item.id).join("/");
                const candidates: Candidate[] = ["left", "right"].map((segment) => ({
                    id: `${parent}/${segment}`,
                    label: segment,
                    segment,
                    selectable: true,
                    navigable: true,
                    replacement: `tree node ${parent}/${segment}`,
                }));

                return candidates;
            }),
    });
}
