"use client";

import InlineAnnotationMenu, { type InlineMenuMode } from "@/components/InlineAnnotationMenu";
import { PaperHighlight } from "@/lib/schema";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

const TOOLTIP_POSITION = { x: 240, y: 120 };
const ALT_TOOLTIP_POSITION = { x: 620, y: 240 };
const LONG_TEXT_SELECTION = (
    "While LLaDA2.1 balances decoding speed and generation quality, "
    + "the joint threshold strategy still depends on context-aware refinement "
    + "to preserve technical meaning in downstream evaluation settings. "
).repeat(40);

export default function TranslationE2EPage() {
    const harnessEnabled = process.env.NEXT_PUBLIC_ENABLE_E2E_HARNESS === "true";
    const searchParams = useSearchParams();
    const paperId = searchParams.get("paperId") || "00000000-0000-0000-0000-000000000001";

    const [selectedText, setSelectedText] = useState("mitigate");
    const [selectedContextBefore, setSelectedContextBefore] = useState(
        "Our adaptation layer is designed to",
    );
    const [selectedContextAfter, setSelectedContextAfter] = useState(
        "domain shift under covariate changes.",
    );
    const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(
        TOOLTIP_POSITION,
    );
    const [menuMode, setMenuMode] = useState<InlineMenuMode>("translation");
    const [isAnnotating, setIsAnnotating] = useState(false);
    const [isSelectionInProgress, setIsSelectionInProgress] = useState(false);
    const [highlights, setHighlights] = useState<PaperHighlight[]>([]);
    const [activeHighlight, setActiveHighlight] = useState<PaperHighlight | null>(null);
    const [userMessageReferences, setUserMessageReferences] = useState<string[]>([]);

    const selectedPageNumber = 1;

    const scenarioLabel = useMemo(() => {
        if (selectedText.length > 240) return "long";
        if (selectedText.includes(".")) return "sentence";
        if (selectedText.includes("(")) return "formula";
        return "word";
    }, [selectedText]);

    if (!harnessEnabled) {
        return (
            <main className="mx-auto max-w-2xl p-8">
                <p className="text-sm text-muted-foreground" data-testid="translation-e2e-disabled">
                    Translation E2E harness is disabled.
                </p>
            </main>
        );
    }

    return (
        <main className="mx-auto max-w-2xl p-8">
            <h1 className="text-xl font-semibold" data-testid="translation-e2e-title">
                Selection Translation E2E Harness
            </h1>
            <p className="mt-2 text-sm text-muted-foreground" data-testid="translation-e2e-scenario">
                Scenario: {scenarioLabel}
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    onClick={() => {
                        setSelectedText("mitigate");
                        setSelectedContextBefore("Our adaptation layer is designed to");
                        setSelectedContextAfter("domain shift under covariate changes.");
                        setMenuMode("translation");
                        setTooltipPosition(TOOLTIP_POSITION);
                    }}
                >
                    Word Case
                </button>
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    onClick={() => {
                        setSelectedText("Our method improves cross-domain generalization.");
                        setSelectedContextBefore("In the out-of-domain benchmark,");
                        setSelectedContextAfter("without adding extra train-time cost.");
                        setMenuMode("translation");
                        setTooltipPosition(TOOLTIP_POSITION);
                    }}
                >
                    Sentence Case
                </button>
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    onClick={() => {
                        setSelectedText("O(n^2)");
                        setSelectedContextBefore("The theoretical complexity remains");
                        setSelectedContextAfter("for dense graph construction.");
                        setMenuMode("translation");
                        setTooltipPosition(TOOLTIP_POSITION);
                    }}
                >
                    Formula Case
                </button>
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    data-testid="translation-e2e-long-case"
                    onClick={() => {
                        setSelectedText(LONG_TEXT_SELECTION);
                        setSelectedContextBefore("This paragraph discusses decoding trade-offs where");
                        setSelectedContextAfter("and the authors report throughput and benchmark metrics.");
                        setMenuMode("translation");
                        setTooltipPosition(TOOLTIP_POSITION);
                    }}
                >
                    Long Case
                </button>
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    data-testid="translation-e2e-reopen"
                    onClick={() => setTooltipPosition(TOOLTIP_POSITION)}
                >
                    Reopen Menu
                </button>
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    data-testid="translation-e2e-move-tooltip"
                    onClick={() => setTooltipPosition(ALT_TOOLTIP_POSITION)}
                >
                    Move Tooltip
                </button>
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    data-testid="translation-e2e-start-drag"
                    onClick={() => setIsSelectionInProgress(true)}
                >
                    Start Drag
                </button>
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    data-testid="translation-e2e-end-drag"
                    onClick={() => setIsSelectionInProgress(false)}
                >
                    End Drag
                </button>
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    data-testid="translation-e2e-mode-translation"
                    onClick={() => setMenuMode("translation")}
                >
                    Translation Mode
                </button>
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    data-testid="translation-e2e-mode-actions"
                    onClick={() => setMenuMode("actions")}
                >
                    Action Mode
                </button>
            </div>

            <p className="mt-4 text-sm" data-testid="translation-e2e-selected-text">
                Selected: {selectedText}
            </p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="translation-e2e-tooltip-position">
                Tooltip: {tooltipPosition ? `${tooltipPosition.x},${tooltipPosition.y}` : "closed"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="translation-e2e-menu-mode">
                Menu mode: {menuMode}
            </p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="translation-e2e-reference-count">
                References captured: {userMessageReferences.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="translation-e2e-highlight-count">
                Highlights created: {highlights.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="translation-e2e-selection-progress">
                Selection in progress: {isSelectionInProgress ? "yes" : "no"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="translation-e2e-annotating">
                Annotating: {isAnnotating ? "yes" : "no"}
            </p>

            <InlineAnnotationMenu
                paperId={paperId}
                selectedPageNumber={selectedPageNumber}
                selectedContextBefore={selectedContextBefore}
                selectedContextAfter={selectedContextAfter}
                selectedText={selectedText}
                tooltipPosition={tooltipPosition}
                setSelectedText={setSelectedText}
                setTooltipPosition={setTooltipPosition}
                setIsAnnotating={setIsAnnotating}
                isSelectionInProgress={isSelectionInProgress}
                isHighlightInteraction={false}
                activeHighlight={activeHighlight}
                addHighlight={(text, doAnnotate) => {
                    const item: PaperHighlight = {
                        id: `h-${Date.now()}`,
                        raw_text: text,
                        role: "user",
                        page_number: selectedPageNumber,
                    };
                    setHighlights((prev) => [...prev, item]);
                    setActiveHighlight(item);
                    if (doAnnotate) {
                        setIsAnnotating(true);
                    }
                    setTooltipPosition(null);
                    setSelectedText("");
                }}
                removeHighlight={(highlight) => {
                    setHighlights((prev) => prev.filter((h) => h.id !== highlight.id));
                    setActiveHighlight(null);
                }}
                setUserMessageReferences={setUserMessageReferences}
                menuMode={menuMode}
            />

            {isAnnotating && (
                <p className="mt-4 text-xs text-muted-foreground">
                    Annotating state was entered.
                </p>
            )}
        </main>
    );
}
