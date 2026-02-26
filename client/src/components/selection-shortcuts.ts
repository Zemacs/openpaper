export type SelectionShortcutAction =
    | "translate"
    | "chat"
    | "highlight"
    | "annotate"
    | "help";

export type SelectionShortcutBindings = Record<SelectionShortcutAction, string>;

export const DEFAULT_SELECTION_SHORTCUT_BINDINGS: SelectionShortcutBindings = {
    translate: "f",
    chat: "c",
    highlight: "e",
    annotate: "n",
    help: "?",
};

export const RESERVED_SHORTCUT_KEYS = new Set([
    "escape",
    "enter",
    "tab",
    "backspace",
    "delete",
    "arrowup",
    "arrowdown",
    "arrowleft",
    "arrowright",
    "home",
    "end",
    "pagedown",
    "pageup",
]);

export const ALLOWED_SHORTCUT_KEYS = [
    ..."abcdefghijklmnopqrstuvwxyz",
    ..."0123456789",
    "?",
] as const;

export function normalizeShortcutKey(rawKey: string): string {
    const key = (rawKey || "").trim();
    if (!key) return "";
    if (key === "?") return "?";
    return key.toLowerCase();
}

export function normalizeShortcutKeyFromKeyboardEvent(event: KeyboardEvent): string {
    if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
        return "?";
    }
    if (event.key.length === 1) {
        return normalizeShortcutKey(event.key);
    }
    return normalizeShortcutKey(event.key);
}

export function isAllowedShortcutKey(key: string): boolean {
    return (ALLOWED_SHORTCUT_KEYS as readonly string[]).includes(key);
}

export function validateSelectionShortcutBindings(bindings: SelectionShortcutBindings): string | null {
    const seen = new Set<string>();
    for (const [action, rawKey] of Object.entries(bindings)) {
        const key = normalizeShortcutKey(rawKey);
        if (!key) {
            return `Shortcut for ${action} cannot be empty.`;
        }
        if (RESERVED_SHORTCUT_KEYS.has(key)) {
            return `Shortcut "${rawKey}" is reserved.`;
        }
        if (!isAllowedShortcutKey(key)) {
            return `Shortcut "${rawKey}" is not allowed.`;
        }
        if (seen.has(key)) {
            return `Shortcut "${rawKey}" is duplicated.`;
        }
        seen.add(key);
    }
    return null;
}
