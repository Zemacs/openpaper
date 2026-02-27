"use client";

import { useCallback, useState } from "react";

import { ArticleReader } from "@/components/ArticleReader";
import { ArticleContentBlock, PaperHighlight } from "@/lib/schema";

const ARTICLE_TEXT = [
    "Transformer models improve sequence modeling by replacing recurrence with attention.",
    "This architecture improves parallelism and long-range dependency learning in NLP tasks.",
    "In practical applications, researchers combine pretraining and fine-tuning for robust performance.",
    "Decoder-only variants emphasize autoregressive generation while encoder-only variants support classification tasks.",
    "Attention heads can learn syntactic and semantic structure when optimized with sufficient data and regularization.",
    "Evaluation typically reports accuracy, robustness, calibration, and latency across in-domain and out-of-domain splits.",
].concat(Array.from({ length: 18 }, (_, index) => `Extended paragraph ${index + 1}: Transformer blocks stack self-attention and feed-forward layers for scalable sequence processing.`)).join("\n\n");

const ARTICLE_BLOCKS: ArticleContentBlock[] = [
    {
        id: "h1",
        type: "header-one",
        text: "Transformer Notes",
    },
    {
        id: "p1",
        type: "unstyled",
        text: "Transformer models improve sequence modeling by replacing recurrence with attention.",
    },
    {
        id: "img1",
        type: "image",
        image_url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='720' viewBox='0 0 1200 720'%3E%3Crect width='1200' height='720' fill='%23dbeafe'/%3E%3Ctext x='60' y='120' font-size='48' fill='%230f172a'%3EOpenPaper Article Image%3C/text%3E%3C/svg%3E",
        caption: "Architecture illustration",
    },
    {
        id: "p2",
        type: "unstyled",
        text: "This architecture improves parallelism and long-range dependency learning in NLP tasks.",
    },
    {
        id: "p3",
        type: "unstyled",
        text: [
            "Large-language systems often require careful evaluation of robustness, calibration, factuality, and latency.",
            "When selection spans multiple wrapped lines, the visual feedback should tightly follow glyph regions instead of extending into empty side gutters.",
            "This paragraph is intentionally long to exercise multi-line drag selection geometry in end-to-end tests.",
        ].join(" "),
    },
];

export default function ArticleReaderE2EPage() {
    const harnessEnabled = process.env.NEXT_PUBLIC_ENABLE_E2E_HARNESS === "true";

    const [selectedText, setSelectedText] = useState("");
    const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
    const [explicitSearchTerm, setExplicitSearchTerm] = useState<string | undefined>(undefined);
    const [isAnnotating, setIsAnnotating] = useState(false);
    const [highlights, setHighlights] = useState<PaperHighlight[]>([]);
    const [activeHighlight, setActiveHighlight] = useState<PaperHighlight | null>(null);
    const [references, setReferences] = useState<string[]>([]);

    const addHighlight = useCallback((text: string, doAnnotate?: boolean) => {
        const item: PaperHighlight = {
            id: `h-${Date.now()}`,
            raw_text: text,
            role: "user",
            page_number: 1,
        };
        setHighlights((prev) => [...prev, item]);
        setActiveHighlight(item);
        if (doAnnotate) {
            setIsAnnotating(true);
        }
        setTooltipPosition(null);
        setSelectedText("");
    }, []);

    const removeHighlight = useCallback((highlight: PaperHighlight) => {
        setHighlights((prev) => prev.filter((h) => h.id !== highlight.id));
        setActiveHighlight(null);
    }, []);

    const selectSampleText = useCallback(() => {
        const paragraph = document.querySelector("#article-container article p");
        if (!paragraph || !paragraph.firstChild) return;
        const textNode = paragraph.firstChild;
        const value = textNode.textContent || "";
        if (value.length < 16) return;

        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, 16);
        const selection = window.getSelection();
        if (!selection) return;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
    }, []);

    if (!harnessEnabled) {
        return (
            <main className="mx-auto max-w-2xl p-8">
                <p className="text-sm text-muted-foreground" data-testid="article-e2e-disabled">
                    Article Reader E2E harness is disabled.
                </p>
            </main>
        );
    }

    return (
        <main className="mx-auto max-w-6xl p-8 space-y-4">
            <h1 className="text-xl font-semibold" data-testid="article-e2e-title">
                Article Reader Selection E2E Harness
            </h1>

            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    data-testid="article-e2e-select-sample"
                    onClick={selectSampleText}
                >
                    Select Sample
                </button>
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    data-testid="article-e2e-clear-selection"
                    onClick={() => {
                        window.getSelection()?.removeAllRanges();
                        setSelectedText("");
                        setTooltipPosition(null);
                    }}
                >
                    Clear Selection
                </button>
                <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    data-testid="article-e2e-citation-search"
                    onClick={() => {
                        setExplicitSearchTerm("long-range dependency learning");
                    }}
                >
                    Trigger Citation Search
                </button>
            </div>

            <p className="text-sm" data-testid="article-e2e-selected-text">
                Selected: {selectedText || "(empty)"}
            </p>
            <p className="text-sm" data-testid="article-e2e-tooltip">
                Tooltip: {tooltipPosition ? `${tooltipPosition.x},${tooltipPosition.y}` : "closed"}
            </p>
            <p className="text-sm" data-testid="article-e2e-highlight-count">
                Highlights: {highlights.length}
            </p>
            <p className="text-sm" data-testid="article-e2e-reference-count">
                References: {references.length}
            </p>
            <p className="text-sm" data-testid="article-e2e-annotating">
                Annotating: {isAnnotating ? "yes" : "no"}
            </p>

            <div className="h-[420px] rounded border border-border">
                <ArticleReader
                    paperId="00000000-0000-0000-0000-000000000001"
                    title="Transformer Notes"
                    rawContent={ARTICLE_TEXT}
                    articleBlocks={ARTICLE_BLOCKS}
                    sourceUrl="https://example.com/transformer"
                    explicitSearchTerm={explicitSearchTerm}
                    selectedText={selectedText}
                    setSelectedText={setSelectedText}
                    tooltipPosition={tooltipPosition}
                    setTooltipPosition={setTooltipPosition}
                    setIsAnnotating={setIsAnnotating}
                    activeHighlight={activeHighlight}
                    addHighlight={addHighlight}
                    removeHighlight={removeHighlight}
                    setUserMessageReferences={setReferences}
                />
            </div>

            <div data-testid="article-e2e-outside" className="h-20 rounded border border-dashed border-border p-3 text-sm text-muted-foreground">
                Outside click area
            </div>
        </main>
    );
}
