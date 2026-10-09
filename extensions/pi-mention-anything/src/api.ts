export {
    createMentionAutocompleteProvider,
    type MentionAutocompleteOptions,
} from "./autocomplete.ts";
export {
    applyMentionEditor,
    type MentionEditorContext,
    type MentionEditorOptions,
} from "./editor.ts";
export {
    contextContainsMentionTrigger,
    expandMentions,
    expandMentionsInMessages,
    type MentionExpansionOptions,
} from "./expand-mentions.ts";
export {
    createLazySelectionHistory,
    rankInitialSuggestions,
    rankWithSelectionHistory,
    type InitialSuggestions,
    type InitialSuggestionStrategy,
    type Selection,
    type SelectionHistory,
    type SelectionHistoryOptions,
} from "./initial-suggestions.ts";
export {
    autocompleteTriggerCharacter,
    escapeRegExp,
    extractMentionPrefix,
    formatMention,
    isMentionContext,
    mentionPattern,
    parseMentionName,
    type MentionPrefix,
    type ParsedMention,
} from "./mention-syntax.ts";
export {
    registerMention,
    type MentionConfiguration,
    type MentionContext,
    type MentionExtensionApi,
    type MentionRegistration,
} from "./register-mention.ts";
export { createListProvider } from "./list-provider.ts";
export {
    createSourceController,
    type SourceController,
    type SourceControllerOptions,
} from "./source-controller.ts";
export {
    createCommandProvider,
    type CommandRequestV1,
    type CommandResponseV1,
} from "./command-provider.ts";
export { parseMentions, formatChain } from "./chain-syntax.ts";
export {
    createChainAutocompleteProvider,
    type ChainCompletionSource,
} from "./chain-autocomplete.ts";
export {
    expandMentionText,
    renderReplacementTemplate,
    type ExpansionSource,
} from "./mention-resolution.ts";
export type {
    Candidate,
    DiscoveryRequest,
    DiscoveryResponse,
    JsonValue,
    Provider,
    Resolution,
    ResolveRequest,
} from "./source-contract.ts";
export { autocompleteStartIndex, colorMentions, type MentionColorContext } from "./rendering.ts";
export { createSelectionHistory } from "./selection-history.ts";
