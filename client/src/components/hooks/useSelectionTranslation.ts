import { useCallback, useEffect, useRef, useState } from "react";

import { fetchFromApi } from "@/lib/api";
import {
    type SelectionTranslationResponse,
    type SelectionTypeHint,
    type TranslateSelectionRequest,
} from "@/lib/schema";

interface TranslateSelectionInput {
    selectedText: string;
    pageNumber?: number;
    selectionTypeHint?: SelectionTypeHint;
    contextBefore?: string;
    contextAfter?: string;
    targetLanguage?: string;
    force?: boolean;
}

const TRANSLATION_TIMEOUT_MS = 18_000;
const MAX_RETRY_ATTEMPTS = 2;
const TRANSIENT_TRANSLATION_ERROR_MARKERS = [
    "llm provider is busy",
    "timed out",
    "timeout",
    "temporarily unavailable",
    "connection was interrupted",
    "network",
    "503",
    "429",
];

function normalizeForKey(value: string | number | null | undefined): string {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isTransientTranslationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return TRANSIENT_TRANSLATION_ERROR_MARKERS.some((marker) => message.includes(marker));
}

function toErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

function buildRequestBody(
    paperId: string,
    payload: TranslateSelectionInput,
    selectedText: string,
): TranslateSelectionRequest {
    return {
        paper_id: paperId,
        selected_text: selectedText,
        page_number: payload.pageNumber,
        selection_type_hint: payload.selectionTypeHint || "auto",
        context_before: payload.contextBefore,
        context_after: payload.contextAfter,
        target_language: payload.targetLanguage || "zh-CN",
    };
}

async function fetchSelectionTranslation(
    requestBody: TranslateSelectionRequest,
    signal: AbortSignal,
): Promise<SelectionTranslationResponse> {
    let response: SelectionTranslationResponse | null = null;
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        try {
            response = await fetchFromApi("/api/translate/selection", {
                method: "POST",
                body: JSON.stringify(requestBody),
                signal,
            }) as SelectionTranslationResponse;
            break;
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw error;
            }
            const shouldRetry = attempt < MAX_RETRY_ATTEMPTS && isTransientTranslationError(error);
            if (!shouldRetry) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
    }

    if (!response) {
        throw new Error("Failed to translate selection.");
    }
    return response;
}

export function useSelectionTranslation(paperId?: string) {
    const [translation, setTranslation] = useState<SelectionTranslationResponse | null>(null);
    const [isTranslating, setIsTranslating] = useState(false);
    const [translationError, setTranslationError] = useState<string | null>(null);

    const cacheRef = useRef(new Map<string, SelectionTranslationResponse>());
    const lastRequestRef = useRef<TranslateSelectionInput | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const inFlightFingerprintRef = useRef<string | null>(null);
    const inFlightPromiseRef = useRef<Promise<SelectionTranslationResponse | null> | null>(null);
    const latestRequestedFingerprintRef = useRef<string | null>(null);

    const makeFingerprint = useCallback((payload: TranslateSelectionInput) => {
        return [
            normalizeForKey(paperId),
            normalizeForKey(payload.selectedText),
            normalizeForKey(payload.pageNumber),
            normalizeForKey(payload.selectionTypeHint || "auto"),
            normalizeForKey(payload.targetLanguage || "zh-CN"),
            normalizeForKey(payload.contextBefore),
            normalizeForKey(payload.contextAfter),
        ].join("|");
    }, [paperId]);

    const isLatestFingerprint = useCallback((fingerprint: string) => {
        return latestRequestedFingerprintRef.current === fingerprint;
    }, []);

    const cancel = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
    }, []);

    useEffect(() => {
        return () => cancel();
    }, [cancel]);

    const clear = useCallback(() => {
        cancel();
        inFlightPromiseRef.current = null;
        inFlightFingerprintRef.current = null;
        latestRequestedFingerprintRef.current = null;
        setTranslation(null);
        setTranslationError(null);
        setIsTranslating(false);
    }, [cancel]);

    const translateSelection = useCallback(
        async (payload: TranslateSelectionInput): Promise<SelectionTranslationResponse | null> => {
            if (!paperId) {
                setTranslationError("Translation is unavailable for this view.");
                return null;
            }

            const selectedText = payload.selectedText.trim();
            if (!selectedText) {
                return null;
            }

            const normalizedPayload: TranslateSelectionInput = {
                ...payload,
                selectedText,
            };
            const fingerprint = makeFingerprint(normalizedPayload);
            latestRequestedFingerprintRef.current = fingerprint;

            if (!payload.force) {
                const cached = cacheRef.current.get(fingerprint);
                if (cached) {
                    if (isLatestFingerprint(fingerprint)) {
                        setTranslation(cached);
                        setTranslationError(null);
                        setIsTranslating(false);
                    }
                    return cached;
                }

                if (
                    inFlightFingerprintRef.current === fingerprint
                    && inFlightPromiseRef.current
                ) {
                    return inFlightPromiseRef.current;
                }
            }

            cancel();
            const controller = new AbortController();
            abortControllerRef.current = controller;
            inFlightFingerprintRef.current = fingerprint;
            lastRequestRef.current = normalizedPayload;
            setIsTranslating(true);
            setTranslationError(null);

            let didTimeout = false;
            const timeoutId = window.setTimeout(() => {
                didTimeout = true;
                controller.abort();
            }, TRANSLATION_TIMEOUT_MS);

            const requestBody = buildRequestBody(paperId, normalizedPayload, selectedText);
            const requestPromise = (async () => {
                try {
                    const response = await fetchSelectionTranslation(requestBody, controller.signal);
                    if (controller.signal.aborted) {
                        return null;
                    }
                    cacheRef.current.set(fingerprint, response);
                    if (isLatestFingerprint(fingerprint)) {
                        setTranslation(response);
                        setTranslationError(null);
                    }
                    return response;
                } catch (error) {
                    if (error instanceof Error && error.name === "AbortError") {
                        if (didTimeout && isLatestFingerprint(fingerprint)) {
                            setTranslationError("Translation request timed out. Please retry.");
                        }
                        return null;
                    }
                    if (isLatestFingerprint(fingerprint)) {
                        setTranslationError(toErrorMessage(error, "Failed to translate selection."));
                    }
                    return null;
                } finally {
                    window.clearTimeout(timeoutId);
                    if (inFlightPromiseRef.current === requestPromise) {
                        inFlightPromiseRef.current = null;
                    }
                    if (inFlightFingerprintRef.current === fingerprint) {
                        inFlightFingerprintRef.current = null;
                    }
                    if (abortControllerRef.current === controller) {
                        abortControllerRef.current = null;
                    }
                    if (isLatestFingerprint(fingerprint)) {
                        setIsTranslating(false);
                    }
                }
            })();

            inFlightPromiseRef.current = requestPromise;
            return requestPromise;
        },
        [cancel, isLatestFingerprint, makeFingerprint, paperId],
    );

    const retryLast = useCallback(async () => {
        if (!lastRequestRef.current) {
            return null;
        }
        return translateSelection({
            ...lastRequestRef.current,
            force: true,
        });
    }, [translateSelection]);

    return {
        translation,
        isTranslating,
        translationError,
        translateSelection,
        retryLast,
        cancel,
        clear,
    };
}
