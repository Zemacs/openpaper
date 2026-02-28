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
        id: "h2-method",
        type: "h2",
        text: "Method",
    },
    {
        id: "p2",
        type: "unstyled",
        text: "This architecture improves parallelism and long-range dependency learning in NLP tasks (Dosovitskiy et al., 2021) with 2^{64} codewords, H2O latents, x2 scaling, and robust token budgets.",
        inline_runs: [
            { type: "text", text: "This " },
            {
                type: "em",
                children: [{ type: "text", text: "architecture" }],
            },
            { type: "text", text: " improves parallelism and long-range dependency learning in NLP tasks (" },
            {
                type: "link",
                href: "#article-ref-ref-7",
                children: [{ type: "text", text: "Dosovitskiy et al., 2021" }],
            },
            { type: "text", text: "; " },
            {
                type: "link",
                href: "#article-ref-ref-1",
                children: [{ type: "text", text: "Vaswani et al., 2017" }],
            },
            { type: "text", text: ") with " },
            { type: "math", text: "2^{64}" },
            { type: "text", text: " codewords, H" },
            {
                type: "sub",
                children: [{ type: "text", text: "2" }],
            },
            { type: "text", text: "O latents, x" },
            {
                type: "sup",
                children: [{ type: "text", text: "2" }],
            },
            { type: "text", text: " scaling, and " },
            {
                type: "strong",
                children: [{ type: "text", text: "robust" }],
            },
            { type: "text", text: " " },
            {
                type: "code",
                children: [{ type: "text", text: "token budgets" }],
            },
            { type: "text", text: ", " },
            {
                type: "smallcaps",
                children: [{ type: "text", text: "latent priors" }],
            },
            { type: "text", text: ", " },
            {
                type: "underline",
                children: [{ type: "text", text: "careful calibration" }],
            },
            { type: "text", text: ", and " },
            {
                type: "strike",
                children: [{ type: "text", text: "obsolete heuristics" }],
            },
            { type: "text", text: "." },
        ],
    },
    {
        id: "eq1",
        type: "equation",
        equation_tex: "Attention(Q, K, V)=softmax\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V,",
        equation_number: "(1)",
    },
    {
        id: "h3-efficiency",
        type: "h3",
        text: "Efficiency",
    },
    {
        id: "list1",
        type: "list",
        ordered: false,
        items: [
            "Self-attention removes recurrent bottlenecks.",
            "Multi-head projections capture diverse relations.",
        ],
    },
    {
        id: "table1",
        type: "table",
        caption: "Benchmark snapshot (multi-level header)",
        header_rows: [
            [
                { text: "Task Group", is_header: true, rowspan: 2, inline_runs: [{ type: "strong", children: [{ type: "text", text: "Task Group" }] }] },
                { text: "Language Pair", is_header: true, colspan: 2 },
                { text: "Metric", is_header: true, rowspan: 2, inline_runs: [{ type: "strong", children: [{ type: "text", text: "Metric" }] }] },
            ],
            [
                { text: "Source", is_header: true },
                { text: "Target", is_header: true, inline_runs: [{ type: "text", text: "Target " }, { type: "math", text: "\\downarrow" }] },
            ],
        ],
        body_rows: [
            [
                { text: "Translation", is_header: true, rowspan: 2, scope: "row" },
                { text: "EN", is_header: false },
                { text: "DE", is_header: false },
                {
                    text: "BLEU 28.4",
                    is_header: false,
                    inline_runs: [
                        { type: "em", children: [{ type: "text", text: "BLEU" }] },
                        { type: "text", text: " " },
                        { type: "strong", children: [{ type: "text", text: "28.4" }] },
                    ],
                },
            ],
            [
                { text: "EN", is_header: false },
                { text: "FR", is_header: false },
                { text: "BLEU 31.2", is_header: false },
            ],
            [
                { text: "Reading Comprehension", is_header: true, scope: "row" },
                { text: "SQuAD", is_header: false, colspan: 2 },
                { text: "EM/F1 82.1/89.3", is_header: false },
            ],
        ],
        notes: ["Note: BLEU reported on WMT14 benchmark splits."],
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
    {
        id: "refs-title",
        type: "h2",
        text: "References",
    },
    {
        id: "ref-1",
        type: "reference",
        text: "A. Vaswani, N. Shazeer, N. Parmar, J. Uszkoreit, and colleagues (2017) Attention is all you need. arXiv preprint arXiv:1706.03762.",
        anchor_id: "article-ref-ref-1",
        links: [
            {
                href: "https://arxiv.org/abs/1706.03762",
                label: "arXiv:1706.03762",
                kind: "arxiv",
            },
        ],
    },
    {
        id: "ref-2",
        type: "reference",
        text: "D. Bahdanau, K. Cho, and Y. Bengio (2015) Neural machine translation by jointly learning to align and translate. ICLR.",
        links: [
            {
                href: "https://arxiv.org/abs/1409.0473",
                label: "arXiv:1409.0473",
                kind: "arxiv",
            },
        ],
    },
    {
        id: "ref-3",
        type: "reference",
        text: "M. Peters and colleagues (2018) Deep contextualized word representations. NAACL.",
        links: [{ href: "https://arxiv.org/abs/1802.05365", label: "arXiv:1802.05365", kind: "arxiv" }],
    },
    {
        id: "ref-4",
        type: "reference",
        text: "J. Devlin and colleagues (2019) BERT: Pre-training of deep bidirectional transformers. NAACL.",
        links: [{ href: "https://arxiv.org/abs/1810.04805", label: "arXiv:1810.04805", kind: "arxiv" }],
    },
    {
        id: "ref-5",
        type: "reference",
        text: "T. Brown and colleagues (2020) Language models are few-shot learners. NeurIPS.",
        links: [{ href: "https://arxiv.org/abs/2005.14165", label: "arXiv:2005.14165", kind: "arxiv" }],
    },
    {
        id: "ref-6",
        type: "reference",
        text: "K. He and colleagues (2016) Deep residual learning for image recognition. CVPR.",
        links: [{ href: "https://arxiv.org/abs/1512.03385", label: "arXiv:1512.03385", kind: "arxiv" }],
    },
    {
        id: "ref-7",
        type: "reference",
        text: "A. Dosovitskiy and colleagues (2021) An image is worth 16x16 words. ICLR.",
        anchor_id: "article-ref-ref-7",
        links: [{ href: "https://arxiv.org/abs/2010.11929", label: "arXiv:2010.11929", kind: "arxiv" }],
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
