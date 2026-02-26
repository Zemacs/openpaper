import { useCallback, useEffect, useMemo, useState } from "react";

import {
    type SelectionShortcutAction,
    type SelectionShortcutBindings,
    DEFAULT_SELECTION_SHORTCUT_BINDINGS,
    normalizeShortcutKey,
    validateSelectionShortcutBindings,
} from "@/components/selection-shortcuts";

const STORAGE_KEY = "openpaper.selection.shortcuts.v1";

interface PersistedShortcutConfig {
    version: 1;
    bindings: SelectionShortcutBindings;
}

function cloneDefaultBindings(): SelectionShortcutBindings {
    return { ...DEFAULT_SELECTION_SHORTCUT_BINDINGS };
}

function parsePersistedBindings(raw: string | null): SelectionShortcutBindings | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<PersistedShortcutConfig>;
        if (parsed.version !== 1 || !parsed.bindings) return null;
        const merged = {
            ...DEFAULT_SELECTION_SHORTCUT_BINDINGS,
            ...parsed.bindings,
        };
        const normalized: SelectionShortcutBindings = {
            translate: normalizeShortcutKey(merged.translate),
            chat: normalizeShortcutKey(merged.chat),
            highlight: normalizeShortcutKey(merged.highlight),
            annotate: normalizeShortcutKey(merged.annotate),
            help: normalizeShortcutKey(merged.help),
        };
        if (validateSelectionShortcutBindings(normalized)) {
            return null;
        }
        return normalized;
    } catch {
        return null;
    }
}

export function useSelectionShortcutConfig() {
    const [bindings, setBindings] = useState<SelectionShortcutBindings>(cloneDefaultBindings);
    const [configError, setConfigError] = useState<string | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const persisted = parsePersistedBindings(window.localStorage.getItem(STORAGE_KEY));
        if (persisted) {
            setBindings(persisted);
            setConfigError(null);
        } else {
            setBindings(cloneDefaultBindings());
        }
        setIsLoaded(true);
    }, []);

    useEffect(() => {
        if (!isLoaded || typeof window === "undefined") return;
        window.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                version: 1,
                bindings,
            } satisfies PersistedShortcutConfig),
        );
    }, [bindings, isLoaded]);

    const updateBinding = useCallback(
        (action: SelectionShortcutAction, rawKey: string): { ok: boolean; error?: string } => {
            const normalizedKey = normalizeShortcutKey(rawKey);
            const nextBindings: SelectionShortcutBindings = {
                ...bindings,
                [action]: normalizedKey,
            };
            const validationError = validateSelectionShortcutBindings(nextBindings);
            if (validationError) {
                setConfigError(validationError);
                return { ok: false, error: validationError };
            }
            setBindings(nextBindings);
            setConfigError(null);
            return { ok: true };
        },
        [bindings],
    );

    const resetBindings = useCallback(() => {
        setBindings(cloneDefaultBindings());
        setConfigError(null);
    }, []);

    const isDirty = useMemo(() => {
        return JSON.stringify(bindings) !== JSON.stringify(DEFAULT_SELECTION_SHORTCUT_BINDINGS);
    }, [bindings]);

    return {
        bindings,
        configError,
        updateBinding,
        resetBindings,
        isDirty,
    };
}
