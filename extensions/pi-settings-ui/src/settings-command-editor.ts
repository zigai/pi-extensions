import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

/** Intercepts Pi's reserved `/settings` submission while preserving the current editor component. */
export function createSettingsCommandEditor(
    base: EditorComponent,
    keybindings: Pick<KeybindingsManager, "matches">,
    openSettings: () => Promise<void>,
    reportOpenFailure: () => void,
): EditorComponent {
    let opening = false;
    const handleInput = base.handleInput.bind(base);

    base.handleInput = (data) => {
        const text = base.getExpandedText?.() ?? base.getText();
        if (
            !opening &&
            text.trim() === "/settings" &&
            keybindings.matches(data, "tui.input.submit")
        ) {
            opening = true;
            base.setText("");
            void openSettings().then(
                () => {
                    opening = false;
                },
                () => {
                    opening = false;
                    reportOpenFailure();
                },
            );

            return;
        }

        handleInput(data);
    };

    return base;
}
