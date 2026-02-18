import { useEffect, useState } from "react";
import { SelectionTranslationResponse } from "@/lib/schema";
import { Button } from "./ui/button";
import { ChevronDown, ChevronUp, Loader, RotateCcw } from "lucide-react";

interface SelectionTranslationCardProps {
    translation: SelectionTranslationResponse | null;
    isLoading: boolean;
    error: string | null;
    onRetry: () => void;
}

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value === "object" && value !== null) {
        return value as Record<string, unknown>;
    }
    return {};
}

export default function SelectionTranslationCard({
    translation,
    isLoading,
    error,
    onRetry,
}: SelectionTranslationCardProps) {
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        setExpanded(false);
    }, [translation?.source_text, translation?.mode]);

    if (isLoading) {
        return (
            <div
                data-testid="selection-translation-loading"
                className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground"
            >
                <div className="flex items-center gap-2">
                    <Loader size={12} className="animate-spin" />
                    Translating selection...
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div
                data-testid="selection-translation-error"
                className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs"
            >
                <div className="text-destructive">{error}</div>
                <Button
                    data-testid="selection-translation-retry"
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-7 px-2 text-xs"
                    onClick={onRetry}
                >
                    <RotateCcw size={12} className="mr-1" />
                    Retry
                </Button>
            </div>
        );
    }

    if (!translation) return null;

    const result = asRecord(translation.result);
    const concise = (result.concise_translation_cn as string | undefined) || "";
    const primary = (result.primary_translation_cn as string | undefined) || "";
    const context = (result.context_translation_cn as string | undefined) || "";
    const explain = (result.meaning_explainer_cn as string | undefined)
        || (result.one_line_explain_cn as string | undefined)
        || (result.formula_explain_cn as string | undefined)
        || "";
    const ipaUs = (result.ipa_us as string | undefined) || "";
    const ipaUk = (result.ipa_uk as string | undefined) || "";
    const pos = (result.pos as string | undefined) || "";
    const usageNotes = Array.isArray(result.usage_notes_cn)
        ? result.usage_notes_cn as string[]
        : [];
    const collocations = Array.isArray(result.collocations)
        ? result.collocations as string[]
        : [];
    const keyTerms = Array.isArray(result.key_terms)
        ? result.key_terms as Array<{ en?: string; cn?: string }>
        : [];
    const contextExampleCn = (result.example_context_cn as string | undefined) || "";
    const contextExampleEn = (result.example_context_en as string | undefined) || "";
    const generalExampleCn = (result.example_general_cn as string | undefined) || "";
    const generalExampleEn = (result.example_general_en as string | undefined) || "";
    const literal = (result.literal_translation_cn as string | undefined) || "";
    const symbolsNotes = Array.isArray(result.symbols_notes_cn)
        ? result.symbols_notes_cn as string[]
        : [];

    return (
        <div
            data-testid="selection-translation-card"
            className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-xs"
        >
            <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Translation</span>
                <span>
                    {Math.round(translation.meta.context_relevance_score * 100)}% context
                </span>
            </div>

            {(concise || primary || context) && (
                <div className="mb-1 font-medium leading-relaxed text-foreground">
                    {concise || context || primary}
                </div>
            )}

            {translation.mode === "word" || translation.mode === "term" ? (
                <>
                    {(ipaUs || ipaUk) && (
                        <div className="mb-1 text-muted-foreground">
                            {ipaUs ? `US ${ipaUs}` : ""}
                            {ipaUs && ipaUk ? " · " : ""}
                            {ipaUk ? `UK ${ipaUk}` : ""}
                        </div>
                    )}
                    {context && context !== primary && (
                        <div className="mb-1 text-muted-foreground">{context}</div>
                    )}
                </>
            ) : null}

            {explain && (
                <div className="text-muted-foreground">{explain}</div>
            )}

            <Button
                data-testid="selection-translation-toggle"
                variant="ghost"
                size="sm"
                className="mt-1 h-7 px-2 text-[11px]"
                onClick={() => setExpanded((v) => !v)}
            >
                {expanded ? <ChevronUp size={12} className="mr-1" /> : <ChevronDown size={12} className="mr-1" />}
                {expanded ? "Less" : "More"}
            </Button>

            {expanded && (
                <div className="mt-1 space-y-1 border-t border-border/60 pt-1 text-muted-foreground">
                    {pos && (
                        <div>
                            <span className="font-medium text-foreground">POS:</span> {pos}
                        </div>
                    )}

                    {usageNotes.length > 0 && (
                        <div>
                            <span className="font-medium text-foreground">Usage:</span> {usageNotes.join("；")}
                        </div>
                    )}

                    {collocations.length > 0 && (
                        <div>
                            <span className="font-medium text-foreground">Collocations:</span> {collocations.join(", ")}
                        </div>
                    )}

                    {keyTerms.length > 0 && (
                        <div>
                            <span className="font-medium text-foreground">Key terms:</span>{" "}
                            {keyTerms
                                .filter((term) => term.en || term.cn)
                                .map((term) => `${term.en || ""}→${term.cn || ""}`)
                                .join("；")}
                        </div>
                    )}

                    {literal && (
                        <div>
                            <span className="font-medium text-foreground">Literal:</span> {literal}
                        </div>
                    )}

                    {symbolsNotes.length > 0 && (
                        <div>
                            <span className="font-medium text-foreground">Symbols:</span> {symbolsNotes.join("；")}
                        </div>
                    )}

                    {(contextExampleCn || contextExampleEn) && (
                        <div>
                            <span className="font-medium text-foreground">Context example:</span>{" "}
                            {[contextExampleEn, contextExampleCn].filter(Boolean).join(" / ")}
                        </div>
                    )}

                    {(generalExampleCn || generalExampleEn) && (
                        <div>
                            <span className="font-medium text-foreground">General example:</span>{" "}
                            {[generalExampleEn, generalExampleCn].filter(Boolean).join(" / ")}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
