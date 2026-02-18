import { useCallback, useRef, useState } from "react";
import { fetchFromApi } from "@/lib/api";
import {
    SelectionTranslationResponse,
    SelectionTypeHint,
    TranslateSelectionRequest,
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

const TRANSLATION_TIMEOUT_MS = 18000;
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

function isTransientTranslationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return TRANSIENT_TRANSLATION_ERROR_MARKERS.some(marker => message.includes(marker));
}

export function useSelectionTranslation(paperId?: string) {
    const [translation, setTranslation] = useState<SelectionTranslationResponse | null>(null);
    const [isTranslating, setIsTranslating] = useState(false);
    const [translationError, setTranslationError] = useState<string | null>(null);

    const cacheRef = useRef<Map<string, SelectionTranslationResponse>>(new Map());
    const abortControllerRef = useRef<AbortController | null>(null);
    const lastRequestRef = useRef<TranslateSelectionInput | null>(null);
    const inFlightFingerprintRef = useRef<string | null>(null);
    const inFlightPromiseRef = useRef<Promise<SelectionTranslationResponse | null> | null>(null);
    const latestRequestedFingerprintRef = useRef<string | null>(null);

    const makeFingerprint = useCallback(
        (payload: TranslateSelectionInput) => {
            const normalizedText = payload.selectedText.replace(/\s+/g, " ").trim().toLowerCase();
            const normalizedBefore = (payload.contextBefore || "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
            const normalizedAfter = (payload.contextAfter || "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
            return [
                paperId || "",
                normalizedText,
                payload.pageNumber || "",
                payload.selectionTypeHint || "auto",
                payload.targetLanguage || "zh-CN",
                normalizedBefore,
                normalizedAfter,
            ].join("|");
        },
        [paperId],
    );

    const cancel = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
    }, []);

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

            const fingerprint = makeFingerprint(payload);
            latestRequestedFingerprintRef.current = fingerprint;
            if (!payload.force) {
                const cached = cacheRef.current.get(fingerprint);
                if (cached) {
                    if (latestRequestedFingerprintRef.current === fingerprint) {
                        setTranslation(cached);
                        setTranslationError(null);
                        setIsTranslating(false);
                    }
                    return cached;
                }

                if (
                    inFlightFingerprintRef.current === fingerprint &&
                    inFlightPromiseRef.current
                ) {
                    return inFlightPromiseRef.current;
                }
            }

            cancel();
            const controller = new AbortController();
            abortControllerRef.current = controller;
            inFlightFingerprintRef.current = fingerprint;
            lastRequestRef.current = payload;
            setIsTranslating(true);
            setTranslationError(null);
            let didTimeout = false;
            const timeoutId = setTimeout(() => {
                didTimeout = true;
                controller.abort();
            }, TRANSLATION_TIMEOUT_MS);

            const requestBody: TranslateSelectionRequest = {
                paper_id: paperId,
                selected_text: selectedText,
                page_number: payload.pageNumber,
                selection_type_hint: payload.selectionTypeHint || "auto",
                context_before: payload.contextBefore,
                context_after: payload.contextAfter,
                target_language: payload.targetLanguage || "zh-CN",
            };

            const requestPromise = (async () => {
                try {
                let response: SelectionTranslationResponse | null = null;
                const maxAttempts = 2;

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    try {
                        response = await fetchFromApi("/api/translate/selection", {
                            method: "POST",
                            body: JSON.stringify(requestBody),
                            signal: controller.signal,
                        }) as SelectionTranslationResponse;
                        break;
                    } catch (error) {
                        if (error instanceof Error && error.name === "AbortError") {
                            throw error;
                        }

                        const shouldRetry = attempt < maxAttempts && isTransientTranslationError(error);
                        if (!shouldRetry) {
                            throw error;
                        }

                        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                    }
                }

                if (!response) {
                    throw new Error("Failed to translate selection.");
                }

                if (controller.signal.aborted) {
                    return null;
                }

                cacheRef.current.set(fingerprint, response);
                if (latestRequestedFingerprintRef.current === fingerprint) {
                    setTranslation(response);
                }
                return response;
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                    if (didTimeout && latestRequestedFingerprintRef.current === fingerprint) {
                        setTranslationError("Translation request timed out. Please retry.");
                    }
                    return null;
                }
                const message = error instanceof Error ? error.message : "Failed to translate selection.";
                if (latestRequestedFingerprintRef.current === fingerprint) {
                    setTranslationError(message);
                }
                return null;
            } finally {
                clearTimeout(timeoutId);
                if (inFlightPromiseRef.current === requestPromise) {
                    inFlightPromiseRef.current = null;
                }
                if (inFlightFingerprintRef.current === fingerprint) {
                    inFlightFingerprintRef.current = null;
                }
                if (abortControllerRef.current === controller) {
                    abortControllerRef.current = null;
                    if (latestRequestedFingerprintRef.current === fingerprint) {
                        setIsTranslating(false);
                    }
                }
            }
            })();

            inFlightPromiseRef.current = requestPromise;
            return requestPromise;
        },
        [cancel, makeFingerprint, paperId],
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
