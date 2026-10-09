import type { TypedCommandFormSymbols } from "../types.ts";

/** Default glyphs used by typed-command forms when a command does not override them. */
export const DEFAULT_FORM_SYMBOLS: Required<TypedCommandFormSymbols> = {
    selectedCheckbox: "■",
    unselectedCheckbox: "□",
    selectedRadio: "●",
    unselectedRadio: "○",
};
