"use client";

import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import InlineAnnotationMenu from "@/components/InlineAnnotationMenu";
import { ArticleContentBlock, PaperHighlight } from "@/lib/schema";

interface ArticleReaderProps {
    paperId?: string;
    title?: string;
    rawContent?: string | null;
    contentFormat?: string | null;
    articleBlocks?: ArticleContentBlock[] | null;
    sourceUrl?: string | null;
    explicitSearchTerm?: string;
    selectedText: string;
    setSelectedText: (value: string) => void;
    tooltipPosition: { x: number; y: number } | null;
    setTooltipPosition: (position: { x: number; y: number } | null) => void;
    setIsAnnotating: (isAnnotating: boolean) => void;
    activeHighlight: PaperHighlight | null;
    addHighlight: (selectedText: string, doAnnotate?: boolean) => void;
    removeHighlight: (highlight: PaperHighlight) => void;
    setUserMessageReferences: Dispatch<SetStateAction<string[]>>;
}

const SELECTION_MENU_SELECTOR = '[data-testid="inline-annotation-menu"]';
const MAX_SELECTION_OVERLAY_CHARS = 2400;
const ARTICLE_CITATION_FOCUS_ATTR = "data-article-citation-focus";
const ARTICLE_CITATION_FOCUS_CLASSES = [
    "rounded-sm",
    "ring-2",
    "ring-amber-400/70",
    "bg-amber-100/45",
    "dark:bg-amber-500/20",
    "transition-colors",
    "duration-200",
];
const ARTICLE_CITATION_FOCUS_TIMEOUT_MS = 4500;

function normalizeSelectionText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function splitArticleParagraphs(text: string): string[] {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return [];

    const byBlankLines = normalized
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter(Boolean);
    if (byBlankLines.length > 1) {
        return byBlankLines;
    }

    const bySentences = normalized
        .split(/(?<=[.!?])\s+/)
        .reduce<string[]>((acc, sentence) => {
            const value = sentence.trim();
            if (!value) return acc;
            const last = acc[acc.length - 1];
            if (!last || last.length > 500) {
                acc.push(value);
            } else {
                acc[acc.length - 1] = `${last} ${value}`;
            }
            return acc;
        }, []);

    return bySentences.length > 0 ? bySentences : [normalized];
}

type NormalizedArticleBlockType = "paragraph" | "h1" | "h2" | "blockquote" | "image";

interface NormalizedArticleBlock {
    id: string;
    type: NormalizedArticleBlockType;
    text?: string;
    imageUrl?: string;
    caption?: string;
}

function normalizeBlockText(value: unknown): string {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeBlockType(value: unknown): NormalizedArticleBlockType {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "header-one" || raw === "h1" || raw === "heading-1") {
        return "h1";
    }
    if (raw === "header-two" || raw === "h2" || raw === "heading-2") {
        return "h2";
    }
    if (raw === "blockquote" || raw === "quote") {
        return "blockquote";
    }
    if (raw === "image" || raw === "photo" || raw === "media") {
        return "image";
    }
    return "paragraph";
}

function normalizeArticleBlocks(blocks: ArticleContentBlock[] | null | undefined): NormalizedArticleBlock[] {
    if (!Array.isArray(blocks) || blocks.length === 0) {
        return [];
    }

    const normalized: NormalizedArticleBlock[] = [];
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (!block || typeof block !== "object") continue;

        const blockType = normalizeBlockType(block.type);
        const blockId = normalizeBlockText(block.id) || `article-block-${index + 1}`;
        if (blockType === "image") {
            const imageUrl = normalizeBlockText(
                block.image_url
                || (block as Record<string, unknown>).url
                || (block as Record<string, unknown>).src,
            );
            if (!imageUrl) continue;
            const caption = normalizeBlockText(block.caption);
            normalized.push({
                id: blockId,
                type: "image",
                imageUrl,
                caption: caption || undefined,
            });
            continue;
        }

        const text = normalizeBlockText(block.text);
        if (!text) continue;
        normalized.push({
            id: blockId,
            type: blockType,
            text,
        });
    }

    return normalized;
}

function isMarkdownContent(contentFormat?: string | null): boolean {
    return (contentFormat || "").trim().toLowerCase() === "markdown";
}

function normalizeSearchTerm(text: string): string {
    let value = text.replace(/^\[\^(\d+|[a-zA-Z]+)\]\s*/, "");
    value = value.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");
    value = value.replace(/\s+/g, " ").trim();
    if (value.length > 240) {
        value = value.slice(0, 240).trimEnd();
    }
    return value;
}

function tokenizeSearchTerm(text: string): string[] {
    const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9_+-]{1,}/g) || [];
    return Array.from(new Set(tokens.filter((token) => token.length >= 3)));
}

function scoreSearchCandidate(
    candidateText: string,
    query: string,
    queryTokens: string[],
    tagName: string,
): number {
    if (!candidateText) return 0;
    const candidate = candidateText.toLowerCase().replace(/\s+/g, " ").trim();
    if (!candidate) return 0;

    let score = 0;
    if (candidate.includes(query)) {
        score += 12;
    }

    const overlap = queryTokens.reduce((count, token) => (
        candidate.includes(token) ? count + 1 : count
    ), 0);
    score += overlap * 1.8;

    if (query.length >= 16) {
        const prefix = query.slice(0, Math.min(96, query.length));
        if (prefix && candidate.includes(prefix)) {
            score += 5;
        }
    }

    if (tagName === "p" || tagName === "li" || tagName === "blockquote") {
        score += 0.8;
    }
    if (/^h[1-6]$/.test(tagName)) {
        score -= 0.5;
    }

    return score;
}

function findBestSearchTarget(container: HTMLDivElement, query: string): HTMLElement | null {
    const article = container.querySelector("article");
    if (!article) return null;

    const queryLower = query.toLowerCase();
    const queryTokens = tokenizeSearchTerm(queryLower);
    const candidateSelector = [
        "p",
        "li",
        "blockquote",
        "pre",
        "td",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
    ].join(", ");
    const candidates = Array.from(article.querySelectorAll<HTMLElement>(candidateSelector));

    let bestElement: HTMLElement | null = null;
    let bestScore = 0;
    for (const element of candidates) {
        const score = scoreSearchCandidate(
            element.innerText || element.textContent || "",
            queryLower,
            queryTokens,
            element.tagName.toLowerCase(),
        );
        if (score > bestScore) {
            bestScore = score;
            bestElement = element;
        }
    }

    if (bestElement) return bestElement;
    return article;
}

function extractSelectionContext(range: Range): { before: string; after: string } {
    const maxChars = 220;

    const normalizeSlice = (text: string, fromEnd: boolean): string => {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (!normalized) return "";
        return fromEnd
            ? normalized.slice(Math.max(0, normalized.length - maxChars))
            : normalized.slice(0, maxChars);
    };

    const boundaryText = (
        container: Node,
        offset: number,
        takeBefore: boolean,
    ): string => {
        if (container.nodeType === Node.TEXT_NODE) {
            const text = container.textContent || "";
            if (takeBefore) {
                return text.slice(0, Math.max(0, Math.min(offset, text.length)));
            }
            return text.slice(Math.max(0, Math.min(offset, text.length)));
        }

        const children = Array.from(container.childNodes);
        if (takeBefore) {
            return children
                .slice(0, Math.max(0, Math.min(offset, children.length)))
                .map((node) => node.textContent || "")
                .join(" ");
        }

        return children
            .slice(Math.max(0, Math.min(offset, children.length)))
            .map((node) => node.textContent || "")
            .join(" ");
    };

    const before = normalizeSlice(
        boundaryText(range.startContainer, range.startOffset, true),
        true,
    );
    const after = normalizeSlice(
        boundaryText(range.endContainer, range.endOffset, false),
        false,
    );
    return { before, after };
}

interface SelectionOverlayRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

function mergeOverlayRects(rects: SelectionOverlayRect[]): SelectionOverlayRect[] {
    if (rects.length <= 1) return rects;

    const sorted = [...rects].sort((a, b) => {
        if (Math.abs(a.top - b.top) > 2) {
            return a.top - b.top;
        }
        return a.left - b.left;
    });

    const merged: SelectionOverlayRect[] = [];
    for (const rect of sorted) {
        const last = merged[merged.length - 1];
        if (!last) {
            merged.push({ ...rect });
            continue;
        }

        const sameLine = Math.abs(last.top - rect.top) <= 1 && Math.abs(last.height - rect.height) <= 2;
        const overlap = rect.left < (last.left + last.width - 0.1);
        if (sameLine && overlap) {
            const right = Math.max(last.left + last.width, rect.left + rect.width);
            last.left = Math.min(last.left, rect.left);
            last.top = Math.min(last.top, rect.top);
            last.width = right - last.left;
            last.height = Math.max(last.height, rect.height);
            continue;
        }

        merged.push({ ...rect });
    }

    return merged;
}

function toOverlayRect(rect: DOMRect, containerRect: DOMRect, container: HTMLDivElement): SelectionOverlayRect | null {
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width < 0.8 || rect.height < 0.8) {
        return null;
    }
    return {
        left: rect.left - containerRect.left + container.scrollLeft,
        top: rect.top - containerRect.top + container.scrollTop,
        width: rect.width,
        height: rect.height,
    };
}

function isCjkCharacter(char: string): boolean {
    const code = char.codePointAt(0);
    if (typeof code !== "number") return false;
    return (
        (code >= 0x3400 && code <= 0x4DBF) // CJK Unified Ideographs Extension A
        || (code >= 0x4E00 && code <= 0x9FFF) // CJK Unified Ideographs
        || (code >= 0xF900 && code <= 0xFAFF) // CJK Compatibility Ideographs
        || (code >= 0x3040 && code <= 0x309F) // Hiragana
        || (code >= 0x30A0 && code <= 0x30FF) // Katakana
        || (code >= 0xAC00 && code <= 0xD7AF) // Hangul Syllables
    );
}

function getCharacterKind(char: string): "whitespace" | "word" | "cjk" | "symbol" {
    if (!char || /\s/.test(char)) return "whitespace";
    if (isCjkCharacter(char)) return "cjk";
    if (/[0-9A-Za-z]/.test(char)) return "word";
    return "symbol";
}

function rangeIntersectsCharacter(range: Range, node: Text, offset: number): boolean {
    if (offset < 0 || offset >= node.data.length) return false;
    const charRange = document.createRange();
    charRange.setStart(node, offset);
    charRange.setEnd(node, offset + 1);

    const charEndsAfterRangeStart = charRange.compareBoundaryPoints(Range.END_TO_START, range) < 0;
    const charStartsBeforeRangeEnd = charRange.compareBoundaryPoints(Range.START_TO_END, range) > 0;
    return charEndsAfterRangeStart && charStartsBeforeRangeEnd;
}

function computeSelectionOverlayRects(range: Range, container: HTMLDivElement): SelectionOverlayRect[] {
    const containerRect = container.getBoundingClientRect();
    const charRects: SelectionOverlayRect[] = [];

    const rootNode = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentNode
        : range.commonAncestorContainer;
    if (!rootNode) {
        return [];
    }

    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
    let processedChars = 0;
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!(node instanceof Text)) continue;
        if (!node.data) continue;

        let intersects = false;
        try {
            intersects = range.intersectsNode(node);
        } catch {
            intersects = false;
        }
        if (!intersects) continue;

        for (let offset = 0; offset < node.data.length; offset += 1) {
            if (processedChars >= MAX_SELECTION_OVERLAY_CHARS) break;
            if (!rangeIntersectsCharacter(range, node, offset)) continue;

            const currentChar = node.data[offset];
            const currentKind = getCharacterKind(currentChar);
            if (currentKind === "whitespace") continue;

            let runEnd = offset + 1;
            if (currentKind === "word") {
                while (runEnd < node.data.length) {
                    if (processedChars + (runEnd - offset) >= MAX_SELECTION_OVERLAY_CHARS) break;
                    if (!rangeIntersectsCharacter(range, node, runEnd)) break;
                    if (getCharacterKind(node.data[runEnd]) !== "word") break;
                    runEnd += 1;
                }
            }

            const runRange = document.createRange();
            runRange.setStart(node, offset);
            runRange.setEnd(node, runEnd);
            const clientRects = Array.from(runRange.getClientRects());
            for (const clientRect of clientRects) {
                const overlay = toOverlayRect(clientRect, containerRect, container);
                if (overlay) {
                    charRects.push(overlay);
                }
            }

            processedChars += Math.max(1, runEnd - offset);
            offset = runEnd - 1;
        }
    }

    if (charRects.length > 0) {
        return mergeOverlayRects(charRects);
    }

    const fallbackRects = Array.from(range.getClientRects())
        .map((clientRect) => toOverlayRect(clientRect, containerRect, container))
        .filter((value): value is SelectionOverlayRect => Boolean(value));
    return mergeOverlayRects(fallbackRects);
}

export function ArticleReader({
    paperId,
    title,
    rawContent,
    contentFormat,
    articleBlocks,
    sourceUrl,
    explicitSearchTerm,
    selectedText,
    setSelectedText,
    tooltipPosition,
    setTooltipPosition,
    setIsAnnotating,
    activeHighlight,
    addHighlight,
    removeHighlight,
    setUserMessageReferences,
}: ArticleReaderProps) {
    const [selectedContextBefore, setSelectedContextBefore] = useState<string | null>(null);
    const [selectedContextAfter, setSelectedContextAfter] = useState<string | null>(null);
    const [selectionOverlayRects, setSelectionOverlayRects] = useState<SelectionOverlayRect[]>([]);
    const [isSelectionInProgress, setIsSelectionInProgress] = useState(false);
    const [readingProgress, setReadingProgress] = useState(0);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const selectionInProgressRef = useRef(false);
    const citationFocusRef = useRef<HTMLElement | null>(null);
    const citationFocusTimerRef = useRef<number | null>(null);
    const markdownMode = useMemo(() => isMarkdownContent(contentFormat), [contentFormat]);
    const structuredBlocks = useMemo(
        () => (markdownMode ? [] : normalizeArticleBlocks(articleBlocks)),
        [articleBlocks, markdownMode],
    );
    const hasStructuredBlocks = structuredBlocks.length > 0;

    const paragraphs = useMemo(
        () => (markdownMode || hasStructuredBlocks ? [] : splitArticleParagraphs(rawContent || "")),
        [rawContent, markdownMode, hasStructuredBlocks],
    );

    const clearSelectionUi = useCallback(() => {
        setSelectedText("");
        setTooltipPosition(null);
        setSelectedContextBefore(null);
        setSelectedContextAfter(null);
        setSelectionOverlayRects([]);
    }, [setSelectedText, setTooltipPosition]);

    const clearCitationFocus = useCallback(() => {
        if (citationFocusTimerRef.current !== null) {
            window.clearTimeout(citationFocusTimerRef.current);
            citationFocusTimerRef.current = null;
        }
        const previous = citationFocusRef.current;
        if (previous) {
            previous.removeAttribute(ARTICLE_CITATION_FOCUS_ATTR);
            previous.classList.remove(...ARTICLE_CITATION_FOCUS_CLASSES);
        }
        citationFocusRef.current = null;
    }, []);

    const setCitationFocus = useCallback((target: HTMLElement) => {
        clearCitationFocus();
        target.classList.add(...ARTICLE_CITATION_FOCUS_CLASSES);
        target.setAttribute(ARTICLE_CITATION_FOCUS_ATTR, "true");
        citationFocusRef.current = target;
        citationFocusTimerRef.current = window.setTimeout(() => {
            clearCitationFocus();
        }, ARTICLE_CITATION_FOCUS_TIMEOUT_MS);
    }, [clearCitationFocus]);

    const applyDomSelection = useCallback((anchorPoint?: { x: number; y: number }) => {
        const container = containerRef.current;
        const domSelection = window.getSelection();
        if (!container || !domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) {
            return false;
        }

        const range = domSelection.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)
            && !container.contains(range.startContainer)
            && !container.contains(range.endContainer)) {
            return false;
        }

        const normalizedSelected = normalizeSelectionText(domSelection.toString());
        if (!normalizedSelected) {
            return false;
        }

        const rect = range.getBoundingClientRect();
        const rectHasGeometry = Number.isFinite(rect.left)
            && Number.isFinite(rect.top)
            && Number.isFinite(rect.width)
            && Number.isFinite(rect.height)
            && rect.width > 0
            && rect.height > 0;

        const x = typeof anchorPoint?.x === "number"
            ? anchorPoint.x
            : rectHasGeometry
                ? rect.right
                : rect.left + rect.width;
        const y = typeof anchorPoint?.y === "number"
            ? anchorPoint.y
            : rectHasGeometry
                ? rect.bottom
                : rect.top + rect.height / 2;

        setSelectedText(normalizedSelected);
        setTooltipPosition({ x, y });

        try {
            const { before, after } = extractSelectionContext(range);
            setSelectedContextBefore(before || null);
            setSelectedContextAfter(after || null);
        } catch {
            setSelectedContextBefore(null);
            setSelectedContextAfter(null);
        }

        setSelectionOverlayRects(computeSelectionOverlayRects(range, container));
        try {
            domSelection.removeAllRanges();
        } catch {
            // Ignore browser-specific selection cleanup errors.
        }

        return true;
    }, [setSelectedText, setTooltipPosition]);

    const updateSelectionOverlayFromDom = useCallback(() => {
        const container = containerRef.current;
        const domSelection = window.getSelection();
        if (!container || !domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) {
            setSelectionOverlayRects([]);
            return false;
        }

        const range = domSelection.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)
            && !container.contains(range.startContainer)
            && !container.contains(range.endContainer)) {
            setSelectionOverlayRects([]);
            return false;
        }

        const normalizedSelected = normalizeSelectionText(domSelection.toString());
        if (!normalizedSelected) {
            setSelectionOverlayRects([]);
            return false;
        }

        setSelectionOverlayRects(computeSelectionOverlayRects(range, container));
        return true;
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const onPointerDown = () => {
            selectionInProgressRef.current = true;
            setIsSelectionInProgress(true);
            setSelectionOverlayRects([]);
        };

        const onPointerUp = (event: PointerEvent) => {
            const wasSelecting = selectionInProgressRef.current;
            selectionInProgressRef.current = false;
            setIsSelectionInProgress(false);
            if (!wasSelecting) return;

            const anchorPoint = { x: event.clientX, y: event.clientY };
            if (!applyDomSelection(anchorPoint)) {
                setTimeout(() => {
                    void applyDomSelection(anchorPoint);
                }, 0);
            }
        };

        const onWindowBlur = () => {
            selectionInProgressRef.current = false;
            setIsSelectionInProgress(false);
        };

        container.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("pointerup", onPointerUp, true);
        window.addEventListener("blur", onWindowBlur);
        return () => {
            container.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("pointerup", onPointerUp, true);
            window.removeEventListener("blur", onWindowBlur);
        };
    }, [applyDomSelection]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        let rafId: number | null = null;

        const onSelectionChange = () => {
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
            }
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (selectionInProgressRef.current) {
                    updateSelectionOverlayFromDom();
                    return;
                }
                void applyDomSelection();
            });
        };

        document.addEventListener("selectionchange", onSelectionChange);
        return () => {
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
            }
            document.removeEventListener("selectionchange", onSelectionChange);
        };
    }, [applyDomSelection, updateSelectionOverlayFromDom]);

    useEffect(() => {
        if (!tooltipPosition) return;

        const handleOutsideClick = (event: MouseEvent) => {
            const target = event.target as Node | null;
            const menuElement = document.querySelector(SELECTION_MENU_SELECTOR);
            if (menuElement && target && menuElement.contains(target)) {
                return;
            }

            const text = normalizeSelectionText(window.getSelection()?.toString() || "");
            if (text) {
                return;
            }

            clearSelectionUi();
            setIsAnnotating(false);
        };

        document.addEventListener("mousedown", handleOutsideClick, true);
        return () => document.removeEventListener("mousedown", handleOutsideClick, true);
    }, [clearSelectionUi, setIsAnnotating, tooltipPosition]);

    useEffect(() => {
        clearSelectionUi();
        clearCitationFocus();
    }, [rawContent, clearSelectionUi, clearCitationFocus]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const updateProgress = () => {
            const maxScrollable = Math.max(1, container.scrollHeight - container.clientHeight);
            const nextValue = Math.max(0, Math.min(1, container.scrollTop / maxScrollable));
            setReadingProgress(nextValue);
        };

        updateProgress();
        container.addEventListener("scroll", updateProgress, { passive: true });
        window.addEventListener("resize", updateProgress);
        return () => {
            container.removeEventListener("scroll", updateProgress);
            window.removeEventListener("resize", updateProgress);
        };
    }, [rawContent, markdownMode]);

    useEffect(() => {
        return () => {
            clearCitationFocus();
        };
    }, [clearCitationFocus]);

    useEffect(() => {
        const searchTerm = normalizeSearchTerm(explicitSearchTerm || "");
        if (!searchTerm) {
            return;
        }

        const container = containerRef.current;
        if (!container) {
            return;
        }

        clearSelectionUi();
        setIsAnnotating(false);
        const domSelection = window.getSelection();
        if (domSelection && domSelection.rangeCount > 0) {
            domSelection.removeAllRanges();
        }

        const target = findBestSearchTarget(container, searchTerm);
        if (!target) {
            return;
        }

        setCitationFocus(target);
        target.scrollIntoView({
            behavior: "smooth",
            block: "center",
            inline: "nearest",
        });
    }, [explicitSearchTerm, clearSelectionUi, setIsAnnotating, setCitationFocus]);

    return (
        <div
            ref={containerRef}
            className="article-selection-scope relative h-full overflow-auto px-4 pb-10 pt-6 md:px-8 lg:px-10"
            id="article-container"
        >
            {selectionOverlayRects.length > 0 && (
                <div aria-hidden className="pointer-events-none absolute inset-0 z-[8]">
                    {selectionOverlayRects.map((rect, index) => (
                        <span
                            key={`${rect.left}-${rect.top}-${rect.width}-${rect.height}-${index}`}
                            className="absolute rounded-[2px] bg-sky-300/55 dark:bg-sky-500/35"
                            data-testid="article-selection-rect"
                            style={{
                                left: `${rect.left}px`,
                                top: `${rect.top}px`,
                                width: `${rect.width}px`,
                                height: `${rect.height}px`,
                            }}
                        />
                    ))}
                </div>
            )}
            <div className="sticky top-0 z-20 -mx-4 mb-5 border-b border-border/50 bg-background/92 px-4 pb-3 pt-2 backdrop-blur md:-mx-8 md:px-8 lg:-mx-10 lg:px-10">
                <div className="mx-auto max-w-3xl">
                    <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>Reading progress</span>
                        <span data-testid="article-reading-progress">
                            {Math.round(readingProgress * 100)}%
                        </span>
                    </div>
                    <div className="h-1 w-full rounded-full bg-muted">
                        <div
                            className="h-1 rounded-full bg-primary transition-all duration-150 ease-out"
                            style={{ width: `${Math.round(readingProgress * 100)}%` }}
                        />
                    </div>
                </div>
            </div>
            <div className="mx-auto max-w-3xl space-y-6">
                <header className="space-y-2 border-b border-border/70 pb-6">
                    {title && <h1 className="text-3xl font-semibold leading-snug tracking-tight">{title}</h1>}
                    {sourceUrl && (
                        <a
                            href={sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-muted-foreground underline underline-offset-2"
                        >
                            Open original source
                        </a>
                    )}
                </header>

                {(rawContent || "").trim() ? (
                    <article className="space-y-4 pb-12 text-[16px] leading-[1.95] tracking-[0.004em] text-foreground/95">
                        {markdownMode ? (
                            <Markdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                    h1: ({ children }) => <h2 className="mt-8 text-2xl font-semibold leading-tight">{children}</h2>,
                                    h2: ({ children }) => <h3 className="mt-7 text-xl font-semibold leading-tight">{children}</h3>,
                                    h3: ({ children }) => <h4 className="mt-6 text-lg font-semibold leading-snug">{children}</h4>,
                                    p: ({ children }) => <p className="text-base leading-[1.95] text-foreground/95">{children}</p>,
                                    blockquote: ({ children }) => (
                                        <blockquote className="border-l-2 border-border pl-4 italic text-foreground/85">
                                            {children}
                                        </blockquote>
                                    ),
                                    ul: ({ children }) => <ul className="list-disc space-y-2 pl-6">{children}</ul>,
                                    ol: ({ children }) => <ol className="list-decimal space-y-2 pl-6">{children}</ol>,
                                    img: ({ src, alt }) => (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={src || ""}
                                            alt={alt || "Article image"}
                                            loading="lazy"
                                            className="my-6 max-h-[620px] w-full rounded-xl border border-border/60 object-contain bg-muted/20"
                                            data-testid="article-image-block"
                                        />
                                    ),
                                    a: ({ href, children }) => (
                                        <a
                                            href={href}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="underline underline-offset-2"
                                        >
                                            {children}
                                        </a>
                                    ),
                                }}
                            >
                                {rawContent || ""}
                            </Markdown>
                        ) : hasStructuredBlocks ? (
                            structuredBlocks.map((block, index) => {
                                if (block.type === "image" && block.imageUrl) {
                                    return (
                                        <figure
                                            key={block.id}
                                            className="my-7 overflow-hidden rounded-xl border border-border/60 bg-muted/15"
                                        >
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                                src={block.imageUrl}
                                                alt={block.caption || `Article image ${index + 1}`}
                                                loading="lazy"
                                                className="max-h-[620px] w-full object-contain"
                                                data-testid="article-image-block"
                                            />
                                            {block.caption && (
                                                <figcaption className="border-t border-border/50 px-4 py-2 text-xs text-muted-foreground">
                                                    {block.caption}
                                                </figcaption>
                                            )}
                                        </figure>
                                    );
                                }

                                if (block.type === "h1") {
                                    return (
                                        <h2 key={block.id} className="mt-8 text-2xl font-semibold leading-tight text-foreground">
                                            {block.text}
                                        </h2>
                                    );
                                }

                                if (block.type === "h2") {
                                    return (
                                        <h3 key={block.id} className="mt-7 text-xl font-semibold leading-tight text-foreground">
                                            {block.text}
                                        </h3>
                                    );
                                }

                                if (block.type === "blockquote") {
                                    return (
                                        <blockquote
                                            key={block.id}
                                            className="border-l-2 border-border pl-4 italic text-foreground/85"
                                        >
                                            {block.text}
                                        </blockquote>
                                    );
                                }

                                return (
                                    <p key={block.id} className="text-base leading-[1.95] text-foreground/95">
                                        {block.text}
                                    </p>
                                );
                            })
                        ) : (
                            paragraphs.map((paragraph, idx) => (
                                <p key={`${idx}-${paragraph.slice(0, 24)}`} className="text-base leading-[1.95] text-foreground/95">
                                    {paragraph}
                                </p>
                            ))
                        )}
                    </article>
                ) : (
                    <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
                        No readable content was extracted for this article yet.
                    </div>
                )}
            </div>

            {tooltipPosition && (
                <InlineAnnotationMenu
                    paperId={paperId}
                    selectedPageNumber={null}
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
                    addHighlight={(text, doAnnotate) => addHighlight(text, doAnnotate)}
                    removeHighlight={removeHighlight}
                    setUserMessageReferences={setUserMessageReferences}
                    menuMode="translation"
                />
            )}
        </div>
    );
}
