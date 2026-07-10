export const NATIVE_COMPACTION_STRATEGY = "pi-codex-core-remote-compaction-v2";
export const NATIVE_COMPACTION_SHIM_SUMMARY = "[Codex native compaction checkpoint]";
export const NATIVE_COMPACTION_MESSAGE_TYPE = "pi-codex-core-native-compaction";
export const NATIVE_COMPACTION_MESSAGE_TEXT = [
    "Codex remote compaction v2 was used for this checkpoint.",
    "The compacted context is provider-specific and not human-readable in Pi.",
    "Avoid disabling native compaction or switching providers mid-session if this checkpoint matters.",
].join("\n");
