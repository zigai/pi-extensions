import { decodeGlowupNode, text, type GlowupNode } from "@zigai/pi-glowup/protocol";

const node: GlowupNode = text("packed protocol");
const decoded = decodeGlowupNode(node);
if (decoded?.kind !== "text") {
    throw new Error("The packed protocol must decode its own public node builders");
}

import {
    output,
    presentGlowupContent,
    presentGlowupSnapshot,
    registerGlowupStreamingPolicy,
    type GlowupContentInput,
} from "@zigai/pi-glowup/protocol";
const generated = output("Ready. Pending", {
    streaming: { kind: "markdown", complete: false, key: "child", mode: "inherit" },
});
if (decodeGlowupNode(generated)?.kind !== "output")
    throw new Error("Missing generated-content declaration");
const input: GlowupContentInput = {
    key: "packed",
    kind: "prose",
    source: "original",
    complete: false,
};
const registration = registerGlowupStreamingPolicy({
    present: (value) => value.source,
    settled: async () => {},
});
if (presentGlowupContent(input) !== "original") throw new Error("Missing shared policy");
await presentGlowupSnapshot(input);
registration.dispose();
