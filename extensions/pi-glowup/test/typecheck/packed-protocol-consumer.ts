import { decodeGlowupNode, text, type GlowupNode } from "@zigai/pi-glowup/protocol";

const node: GlowupNode = text("packed protocol");
const decoded = decodeGlowupNode(node);
if (decoded?.kind !== "text") {
    throw new Error("The packed protocol must decode its own public node builders");
}
