import { type SelectionShortcutAction, type SelectionShortcutBindings, ALLOWED_SHORTCUT_KEYS } from "@/components/selection-shortcuts";
import { Button } from "@/components/ui/button";

interface SelectionShortcutHelpProps {
    selectedText: string;
    bindings: SelectionShortcutBindings;
    configError: string | null;
    onUpdateBinding: (
        action: SelectionShortcutAction,
        key: string,
    ) => { ok: boolean; error?: string };
    onResetBindings: () => void;
}

const ACTION_LABELS: Record<SelectionShortcutAction, string> = {
    translate: "Translate",
    chat: "Chat",
    highlight: "Highlight",
    annotate: "Annotate",
    help: "Help",
};

function formatShortcutLabel(key: string): string {
    if (key === "?") return "Shift + / (?)";
    return key.toUpperCase();
}

export default function SelectionShortcutHelp({
    selectedText,
    bindings,
    configError,
    onUpdateBinding,
    onResetBindings,
}: SelectionShortcutHelpProps) {
    return (
        <div
            data-testid="selection-shortcut-help"
            className="rounded-xl border border-border bg-background/95 p-3 text-xs shadow-xl backdrop-blur-sm"
            role="dialog"
            aria-label="Selection shortcuts"
        >
            <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">Selection Shortcuts</p>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    data-testid="selection-shortcut-reset"
                    onClick={onResetBindings}
                >
                    Reset
                </Button>
            </div>

            <p className="mb-2 line-clamp-2 text-muted-foreground">
                {selectedText || "No text selected."}
            </p>

            <div className="mb-2 space-y-1.5">
                {(Object.keys(ACTION_LABELS) as SelectionShortcutAction[]).map((action) => (
                    <label
                        key={action}
                        className="flex items-center justify-between gap-2"
                    >
                        <span className="text-foreground">{ACTION_LABELS[action]}</span>
                        <select
                            data-testid={`selection-shortcut-select-${action}`}
                            value={bindings[action]}
                            onChange={(event) => {
                                onUpdateBinding(action, event.target.value);
                            }}
                            className="h-7 min-w-[120px] rounded border border-border bg-background px-2 text-xs"
                        >
                            {ALLOWED_SHORTCUT_KEYS.map((key) => (
                                <option key={key} value={key}>
                                    {formatShortcutLabel(key)}
                                </option>
                            ))}
                        </select>
                    </label>
                ))}
            </div>

            <div className="mt-2 rounded border border-border/70 bg-muted/40 p-2 text-[11px] text-muted-foreground">
                <p>
                    Trigger actions after selecting text: {formatShortcutLabel(bindings.translate)} translate,{" "}
                    {formatShortcutLabel(bindings.chat)} chat, {formatShortcutLabel(bindings.highlight)} highlight,{" "}
                    {formatShortcutLabel(bindings.annotate)} annotate.
                </p>
                <p className="mt-1">Press {formatShortcutLabel(bindings.help)} to toggle this panel. Press Esc to dismiss selection.</p>
            </div>

            {configError && (
                <p
                    data-testid="selection-shortcut-config-error"
                    className="mt-2 text-[11px] text-destructive"
                >
                    {configError}
                </p>
            )}
        </div>
    );
}
