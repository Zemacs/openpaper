"use client";

import { Dispatch, MouseEvent as ReactMouseEvent, ReactNode, SetStateAction, WheelEvent as ReactWheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

import InlineAnnotationMenu from "@/components/InlineAnnotationMenu";
import { ArticleContentBlock, ArticleInlineRun, PaperHighlight } from "@/lib/schema";

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
const ARTICLE_CITATION_FOCUS_ATTR = "data-article-citation-focus";
const ARTICLE_CITATION_FOCUS_CLASSES = [
    "article-reference-card-focused",
];
const ARTICLE_CITATION_FOCUS_TIMEOUT_MS = 4500;
const ARTICLE_CITATION_SOURCE_ACTIVE_CLASS = "article-citation-source-active";
const ARTICLE_CITATION_SOURCE_RETURN_CLASS = "article-citation-source-returned";

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

type NormalizedArticleBlockType =
    | "paragraph"
    | "h1"
    | "h2"
    | "h3"
    | "blockquote"
    | "image"
    | "equation"
    | "table"
    | "list"
    | "code"
    | "reference";

interface NormalizedBlockLink {
    href: string;
    label: string;
    kind?: string;
}

interface NormalizedArticleBlock {
    id: string;
    type: NormalizedArticleBlockType;
    text?: string;
    inlineMarkdown?: string;
    inlineRuns?: NormalizedInlineRun[];
    anchorId?: string;
    imageUrl?: string;
    caption?: string;
    equationTex?: string;
    equationNumber?: string;
    ordered?: boolean;
    items?: string[];
    columns?: string[];
    rows?: string[][];
    headerRows?: NormalizedTableCell[][];
    bodyRows?: NormalizedTableCell[][];
    notes?: string[];
    links?: NormalizedBlockLink[];
}

interface NormalizedTableCell {
    text: string;
    inlineMarkdown?: string;
    inlineRuns?: NormalizedInlineRun[];
    isHeader: boolean;
    colSpan: number;
    rowSpan: number;
    scope?: string;
}

type NormalizedInlineRunType = "text" | "link" | "math" | "em" | "strong" | "code" | "sub" | "sup" | "underline" | "strike" | "smallcaps";

interface NormalizedInlineRun {
    type: NormalizedInlineRunType;
    text?: string;
    href?: string;
    children?: NormalizedInlineRun[];
}

interface StructuredArticleSections {
    contentBlocks: NormalizedArticleBlock[];
    referenceBlocks: NormalizedArticleBlock[];
    referenceTitle: string;
}

interface ArticleTocItem {
    blockId: string;
    anchorId: string;
    text: string;
    level: 1 | 2 | 3;
}

type ArticlePreviewState =
    | {
        kind: "image";
        title: string;
        imageSrc: string;
        imageAlt: string;
        caption?: string;
        sourceHref?: string;
    }
    | {
        kind: "table";
        title: string;
        tableBlock: NormalizedArticleBlock;
        caption?: string;
    }
    | {
        kind: "equation";
        title: string;
        equationTex: string;
        equationNumber?: string;
    };

interface ReferenceNavigationState {
    anchorId: string;
    returnScrollTop: number;
    canReturn: boolean;
}

interface ImageFocusCrop {
    aspectRatio: number;
    objectPositionX: number;
    objectPositionY: number;
}

interface ImageNaturalMetrics {
    width: number;
    height: number;
}

const REFERENCE_PREVIEW_COUNT = 5;
const IMAGE_FOCUS_SAMPLE_LIMIT = 320;
const imageFocusCache = new Map<string, ImageFocusCrop | null>();
const imageNaturalMetricsCache = new Map<string, ImageNaturalMetrics | null>();

function getArticleHeadingAnchorId(blockId: string): string {
    return `article-heading-${normalizeBlockText(blockId) || "section"}`;
}

function getHeadingLevel(type: NormalizedArticleBlockType): 1 | 2 | 3 | null {
    if (type === "h1") return 1;
    if (type === "h2") return 2;
    if (type === "h3") return 3;
    return null;
}

function normalizeBlockText(value: unknown): string {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function clampPercentage(value: number): number {
    if (!Number.isFinite(value)) {
        return 50;
    }
    return Math.max(0, Math.min(100, value));
}

function detectImageFocusCrop(imageSrc: string): Promise<ImageFocusCrop | null> {
    return new Promise((resolve) => {
        if (typeof window === "undefined" || !imageSrc) {
            resolve(null);
            return;
        }

        const loader = new window.Image();
        loader.decoding = "async";
        loader.crossOrigin = "anonymous";

        loader.onload = () => {
            const naturalWidth = loader.naturalWidth;
            const naturalHeight = loader.naturalHeight;
            if (!naturalWidth || !naturalHeight) {
                resolve(null);
                return;
            }

            const scale = Math.min(1, IMAGE_FOCUS_SAMPLE_LIMIT / Math.max(naturalWidth, naturalHeight));
            const sampleWidth = Math.max(16, Math.round(naturalWidth * scale));
            const sampleHeight = Math.max(16, Math.round(naturalHeight * scale));
            const canvas = document.createElement("canvas");
            canvas.width = sampleWidth;
            canvas.height = sampleHeight;

            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) {
                resolve(null);
                return;
            }

            try {
                context.drawImage(loader, 0, 0, sampleWidth, sampleHeight);
                const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);

                const corners = [
                    0,
                    sampleWidth - 1,
                    (sampleHeight - 1) * sampleWidth,
                    sampleHeight * sampleWidth - 1,
                ]
                    .map((pixelIndex) => pixelIndex * 4)
                    .filter((pixelIndex) => pixelIndex >= 0 && pixelIndex + 3 < data.length);

                const background = corners.reduce((acc, pixelIndex) => {
                    acc.r += data[pixelIndex];
                    acc.g += data[pixelIndex + 1];
                    acc.b += data[pixelIndex + 2];
                    return acc;
                }, { r: 0, g: 0, b: 0 });
                const divisor = Math.max(1, corners.length);
                const backgroundR = background.r / divisor;
                const backgroundG = background.g / divisor;
                const backgroundB = background.b / divisor;

                let minX = sampleWidth;
                let minY = sampleHeight;
                let maxX = -1;
                let maxY = -1;

                for (let y = 0; y < sampleHeight; y += 1) {
                    for (let x = 0; x < sampleWidth; x += 1) {
                        const pixelIndex = (y * sampleWidth + x) * 4;
                        const alpha = data[pixelIndex + 3];
                        if (alpha <= 20) {
                            continue;
                        }

                        const red = data[pixelIndex];
                        const green = data[pixelIndex + 1];
                        const blue = data[pixelIndex + 2];
                        const colorDistance = Math.abs(red - backgroundR) + Math.abs(green - backgroundG) + Math.abs(blue - backgroundB);
                        const luminance = (red + green + blue) / 3;
                        if (colorDistance < 42 && luminance > 232) {
                            continue;
                        }

                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    }
                }

                if (maxX < minX || maxY < minY) {
                    resolve(null);
                    return;
                }

                const cropWidth = maxX - minX + 1;
                const cropHeight = maxY - minY + 1;
                const horizontalTrim = 1 - cropWidth / sampleWidth;
                const verticalTrim = 1 - cropHeight / sampleHeight;

                if (horizontalTrim < 0.04 && verticalTrim < 0.08) {
                    resolve(null);
                    return;
                }

                if (cropWidth < sampleWidth * 0.18 || cropHeight < sampleHeight * 0.12) {
                    resolve(null);
                    return;
                }

                const aspectRatio = cropWidth / cropHeight;
                if (!Number.isFinite(aspectRatio) || aspectRatio < 0.25 || aspectRatio > 8) {
                    resolve(null);
                    return;
                }

                const objectPositionX = clampPercentage(((minX + maxX + 1) / 2 / sampleWidth) * 100);
                const objectPositionY = clampPercentage(((minY + maxY + 1) / 2 / sampleHeight) * 100);

                resolve({
                    aspectRatio,
                    objectPositionX,
                    objectPositionY,
                });
            } catch {
                resolve(null);
            }
        };

        loader.onerror = () => resolve(null);
        loader.src = imageSrc;
    });
}

function loadImageNaturalMetrics(imageSrc: string): Promise<ImageNaturalMetrics | null> {
    return new Promise((resolve) => {
        if (typeof window === "undefined" || !imageSrc) {
            resolve(null);
            return;
        }

        const loader = new window.Image();
        loader.decoding = "async";
        loader.onload = () => {
            const width = loader.naturalWidth;
            const height = loader.naturalHeight;
            if (!width || !height) {
                resolve(null);
                return;
            }
            resolve({ width, height });
        };
        loader.onerror = () => resolve(null);
        loader.src = imageSrc;
    });
}


function normalizeInlineMarkdownValue(value: unknown): string {
    return String(value ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .trim();
}

function normalizeInlineRunText(value: unknown): string {
    return String(value ?? "")
        .replace(/\u00a0/g, " ")
        .replace(/\u200b/g, "")
        .replace(/\ufeff/g, "");
}

function extractInternalReferenceAnchorId(href: string | null | undefined): string {
    const normalizedHref = normalizeBlockText(href);
    if (!normalizedHref.startsWith("#")) {
        return "";
    }
    return normalizedHref.slice(1);
}

function isReferenceHeadingText(value: string | undefined): boolean {
    const normalized = normalizeBlockText(value).toLowerCase();
    return normalized === "references" || normalized === "bibliography";
}

function normalizeMultilineBlockText(value: unknown): string {
    return String(value ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();
}

function normalizeEquationTex(value: unknown): string {
    let normalized = normalizeMultilineBlockText(value);
    if (!normalized) return "";
    if (normalized.startsWith("$$") && normalized.endsWith("$$") && normalized.length > 4) {
        normalized = normalized.slice(2, -2).trim();
    }
    if (normalized.startsWith("\\[") && normalized.endsWith("\\]") && normalized.length > 4) {
        normalized = normalized.slice(2, -2).trim();
    }
    return normalized;
}

function isArxivHost(hostname: string): boolean {
    const normalizedHostname = hostname.trim().toLowerCase();
    return normalizedHostname === "arxiv.org" || normalizedHostname.endsWith(".arxiv.org");
}

function buildArticleAssetBaseUrl(sourceUrl: string): string | null {
    try {
        const parsed = new URL(sourceUrl);
        parsed.search = "";
        parsed.hash = "";
        if (!parsed.pathname.endsWith("/")) {
            parsed.pathname = `${parsed.pathname}/`;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

function repairLegacyArxivImageUrl(imageUrl: URL, sourceUrl?: string | null): string {
    const normalizedSourceUrl = normalizeBlockText(sourceUrl);
    if (!normalizedSourceUrl) {
        return imageUrl.toString();
    }

    let parsedSourceUrl: URL;
    try {
        parsedSourceUrl = new URL(normalizedSourceUrl);
    } catch {
        return imageUrl.toString();
    }

    if (!isArxivHost(parsedSourceUrl.hostname) || !isArxivHost(imageUrl.hostname)) {
        return imageUrl.toString();
    }

    const legacyImageMatch = imageUrl.pathname.match(/^\/html\/([^/]+\.[A-Za-z0-9]{2,10})$/);
    const sourceMatch = parsedSourceUrl.pathname.match(/^\/html\/([^/?#]+)$/);
    if (!legacyImageMatch || !sourceMatch) {
        return imageUrl.toString();
    }

    const assetName = legacyImageMatch[1];
    const identifier = sourceMatch[1];
    imageUrl.pathname = `/html/${identifier}/${assetName}`;
    imageUrl.search = "";
    imageUrl.hash = "";
    return imageUrl.toString();
}

function resolveArticleImageUrl(value: unknown, sourceUrl?: string | null): string {
    const normalizedValue = normalizeBlockText(value);
    if (!normalizedValue) return "";
    if (normalizedValue.startsWith("data:") || normalizedValue.startsWith("blob:")) {
        return normalizedValue;
    }

    const assetBaseUrl = sourceUrl ? buildArticleAssetBaseUrl(sourceUrl) : null;
    try {
        const resolvedUrl = assetBaseUrl
            ? new URL(normalizedValue, assetBaseUrl)
            : new URL(normalizedValue);
        return repairLegacyArxivImageUrl(resolvedUrl, sourceUrl);
    } catch {
        return normalizedValue;
    }
}

function normalizeEquationForDisplay(value: unknown): string {
    let normalized = normalizeEquationTex(value);
    if (!normalized) return "";

    normalized = normalized.replace(
        /(^|[^\\A-Za-z])([A-Za-z][A-Za-z0-9]{1,})(?=\s*\()/g,
        (_, prefix: string, operatorName: string) => `${prefix}\\operatorname{${operatorName}}`,
    );

    if (
        /[,:;.]$/.test(normalized)
        && !normalized.endsWith("\\,")
        && !normalized.endsWith("\\;")
        && !normalized.endsWith("\\:")
        && !normalized.endsWith("\\.")
    ) {
        normalized = normalized.slice(0, -1).trimEnd();
    }

    return normalized;
}

function buildDisplayMathMarkdown(equationTex: string): string {
    const normalized = normalizeEquationForDisplay(equationTex);
    if (!normalized) return "";
    return `$$\n${normalized}\n$$`;
}

function coerceStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const output: string[] = [];
    for (const item of value) {
        const text = normalizeBlockText(item);
        if (!text) continue;
        output.push(text);
    }
    return output;
}

function coerceTableRows(value: unknown): string[][] {
    if (!Array.isArray(value)) {
        return [];
    }
    const rows: string[][] = [];
    for (const row of value) {
        if (!Array.isArray(row)) continue;
        const cells = coerceStringArray(row);
        if (cells.length === 0) continue;
        rows.push(cells);
    }
    return rows;
}

function coercePositiveInt(value: unknown, fallback: number = 1): number {
    const parsed = Number.parseInt(String(value ?? fallback), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

function coerceStructuredTableRows(value: unknown): NormalizedTableCell[][] {
    if (!Array.isArray(value)) {
        return [];
    }
    const rows: NormalizedTableCell[][] = [];
    for (const rawRow of value) {
        if (!Array.isArray(rawRow)) continue;
        const parsedRow: NormalizedTableCell[] = [];
        for (const rawCell of rawRow) {
            if (!rawCell || typeof rawCell !== "object") continue;
            const cell = rawCell as Record<string, unknown>;
            const text = normalizeBlockText(cell.text);
            const colSpan = coercePositiveInt(cell.colspan, 1);
            const rowSpan = coercePositiveInt(cell.rowspan, 1);
            const isHeader = Boolean(cell.is_header);
            if (!text && colSpan === 1 && rowSpan === 1) continue;
            const scope = normalizeBlockText(cell.scope).toLowerCase();
            const inlineMarkdown = normalizeInlineMarkdownValue(cell.inline_markdown);
            const inlineRuns = normalizeInlineRuns(cell.inline_runs);
            parsedRow.push({
                text,
                inlineMarkdown: inlineMarkdown || undefined,
                inlineRuns: inlineRuns.length > 0 ? inlineRuns : undefined,
                isHeader,
                colSpan,
                rowSpan,
                scope: scope || undefined,
            });
        }
        if (parsedRow.length === 0) continue;
        rows.push(parsedRow);
    }
    return rows;
}

function countStructuredRowColumns(row: NormalizedTableCell[]): number {
    return row.reduce((total, cell) => total + Math.max(1, cell.colSpan || 1), 0);
}

function getStructuredTableColumnCount(block: NormalizedArticleBlock): number {
    const headerRows = block.headerRows || [];
    const bodyRows = block.bodyRows || [];
    const allRows = [...headerRows, ...bodyRows];
    const maxFromRows = allRows.reduce((maxValue, row) => (
        Math.max(maxValue, countStructuredRowColumns(row))
    ), 0);

    if (maxFromRows > 0) {
        return maxFromRows;
    }

    if (block.columns && block.columns.length > 0) {
        return block.columns.length;
    }

    return 1;
}

function isCompactNumericTableText(value: string): boolean {
    const normalized = normalizeBlockText(value).replace(/\s+/g, "");
    if (!normalized) return false;
    return /^[-+~≈<>≤≥]?(?:\d+(?:\.\d+)?(?:[%])?|\d+(?:\.\d+)?(?:×10\^?\(?-?\d+\)?)?|OOM|N\/A|NA|INF)$/i.test(normalized);
}

function estimateTableCellWidthCh(cell: NormalizedTableCell): number {
    const text = normalizeBlockText(cell.text);
    if (!text) {
        return 8;
    }

    if (isCompactNumericTableText(text)) {
        return Math.max(7, Math.min(11, text.replace(/\s+/g, "").length + 1));
    }

    const tokens = text.split(/\s+/).filter(Boolean);
    const longestToken = tokens.reduce((maxValue, token) => Math.max(maxValue, token.length), 0);
    const hasInlineMath = Boolean(cell.inlineRuns?.some((run) => run.type === "math"));
    const weightedLength = Math.max(
        longestToken,
        Math.ceil(text.length * (cell.isHeader ? 0.88 : 0.72)),
    );
    const width = weightedLength + (hasInlineMath ? 2 : 0) + (cell.isHeader ? 1 : 0);
    return Math.max(9, Math.min(24, width));
}

function getStructuredTableColumnLayout(block: NormalizedArticleBlock): {
    columnCount: number;
    columnWidths: string[];
    minWidthRem: number;
} {
    const columnCount = getStructuredTableColumnCount(block);
    const widthScores = Array.from({ length: columnCount }, () => 9);
    const rows = [...(block.headerRows || []), ...(block.bodyRows || [])];
    const occupied = Array.from({ length: columnCount }, () => 0);

    for (const row of rows) {
        const nextOccupied = Array.from({ length: columnCount }, () => 0);
        let columnIndex = 0;

        const advanceToAvailableColumn = () => {
            while (columnIndex < columnCount && occupied[columnIndex] > 0) {
                columnIndex += 1;
            }
        };

        advanceToAvailableColumn();

        for (const cell of row) {
            advanceToAvailableColumn();
            if (columnIndex >= columnCount) {
                break;
            }

            const colSpan = Math.max(1, Math.min(columnCount - columnIndex, cell.colSpan || 1));
            const rowSpan = Math.max(1, cell.rowSpan || 1);
            const perColumnWidth = estimateTableCellWidthCh(cell) / colSpan;

            for (let offset = 0; offset < colSpan; offset += 1) {
                const targetIndex = columnIndex + offset;
                widthScores[targetIndex] = Math.max(widthScores[targetIndex], perColumnWidth);
                if (rowSpan > 1) {
                    nextOccupied[targetIndex] = Math.max(nextOccupied[targetIndex], rowSpan - 1);
                }
            }

            columnIndex += colSpan;
        }

        for (let index = 0; index < columnCount; index += 1) {
            occupied[index] = Math.max(0, occupied[index] - 1, nextOccupied[index]);
        }
    }

    const normalizedWidths = widthScores.map((score) => Math.max(6, Math.min(18, Math.round(score))));
    const totalWidthUnits = Math.max(
        1,
        normalizedWidths.reduce((total, value) => total + value, 0),
    );
    const minWidthRem = Math.max(
        24,
        Math.min(96, Math.round(totalWidthUnits * 0.52)),
    );

    return {
        columnCount,
        columnWidths: normalizedWidths.map((value) => `${((value / totalWidthUnits) * 100).toFixed(4)}%`),
        minWidthRem,
    };
}

function coerceBlockLinks(value: unknown): NormalizedBlockLink[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const links: NormalizedBlockLink[] = [];
    for (const rawLink of value) {
        if (!rawLink || typeof rawLink !== "object") continue;
        const link = rawLink as Record<string, unknown>;
        const href = normalizeBlockText(link.href);
        if (!href) continue;
        let resolvedHref = href;
        try {
            resolvedHref = new URL(href).toString();
        } catch {
            continue;
        }
        const label = normalizeBlockText(link.label) || resolvedHref;
        const kind = normalizeBlockText(link.kind).toLowerCase() || undefined;
        links.push({
            href: resolvedHref,
            label,
            kind,
        });
    }
    return links;
}

function normalizeBlockType(value: unknown): NormalizedArticleBlockType {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "header-one" || raw === "h1" || raw === "heading-1") {
        return "h1";
    }
    if (raw === "header-two" || raw === "h2" || raw === "heading-2") {
        return "h2";
    }
    if (raw === "header-three" || raw === "h3" || raw === "heading-3") {
        return "h3";
    }
    if (raw === "blockquote" || raw === "quote") {
        return "blockquote";
    }
    if (raw === "image" || raw === "photo" || raw === "media") {
        return "image";
    }
    if (raw === "equation" || raw === "formula" || raw === "math") {
        return "equation";
    }
    if (raw === "table" || raw === "tabular") {
        return "table";
    }
    if (raw === "list" || raw === "ul" || raw === "ol" || raw === "bullet_list") {
        return "list";
    }
    if (raw === "code" || raw === "pre" || raw === "code_block") {
        return "code";
    }
    if (raw === "reference" || raw === "citation" || raw === "bibliography_item") {
        return "reference";
    }
    return "paragraph";
}

function normalizeArticleBlocks(
    blocks: ArticleContentBlock[] | null | undefined,
    sourceUrl?: string | null,
    articleTitle?: string,
): NormalizedArticleBlock[] {
    if (!Array.isArray(blocks) || blocks.length === 0) {
        return [];
    }

    const normalized: NormalizedArticleBlock[] = [];
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (!block || typeof block !== "object") continue;

        const rawType = String(block.type || "").trim().toLowerCase();
        const blockType = normalizeBlockType(rawType);
        const blockId = normalizeBlockText(block.id) || `article-block-${index + 1}`;
        if (blockType === "image") {
            const imageUrl = resolveArticleImageUrl(
                block.image_url
                || (block as Record<string, unknown>).url
                || (block as Record<string, unknown>).src,
                sourceUrl,
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

        if (blockType === "equation") {
            const equationTex = normalizeEquationForDisplay(
                (block as Record<string, unknown>).equation_tex
                || (block as Record<string, unknown>).latex
                || block.text,
            );
            if (!equationTex) continue;
            const equationNumber = normalizeBlockText((block as Record<string, unknown>).equation_number);
            normalized.push({
                id: blockId,
                type: "equation",
                equationTex,
                equationNumber: equationNumber || undefined,
            });
            continue;
        }

        if (blockType === "table") {
            const columns = coerceStringArray((block as Record<string, unknown>).columns);
            const rows = coerceTableRows((block as Record<string, unknown>).rows);
            const headerRows = coerceStructuredTableRows((block as Record<string, unknown>).header_rows);
            const bodyRows = coerceStructuredTableRows((block as Record<string, unknown>).body_rows);
            const notes = coerceStringArray((block as Record<string, unknown>).notes);
            const caption = normalizeBlockText(block.caption);
            if (columns.length === 0 && rows.length === 0 && headerRows.length === 0 && bodyRows.length === 0) continue;

            let resolvedHeaderRows = headerRows;
            let resolvedBodyRows = bodyRows;
            if (resolvedHeaderRows.length === 0 && columns.length > 0) {
                resolvedHeaderRows = [[
                    ...columns.map((column) => ({
                        text: column,
                        isHeader: true,
                        colSpan: 1,
                        rowSpan: 1,
                    })),
                ]];
            }
            if (resolvedBodyRows.length === 0 && rows.length > 0) {
                resolvedBodyRows = rows.map((row) => (
                    row.map((value) => ({
                        text: value,
                        isHeader: false,
                        colSpan: 1,
                        rowSpan: 1,
                    }))
                ));
            }

            normalized.push({
                id: blockId,
                type: "table",
                caption: caption || undefined,
                columns,
                rows,
                headerRows: resolvedHeaderRows,
                bodyRows: resolvedBodyRows,
                notes,
            });
            continue;
        }

        if (blockType === "list") {
            const items = coerceStringArray((block as Record<string, unknown>).items);
            if (items.length === 0) {
                const textFallback = normalizeBlockText(block.text);
                if (textFallback) {
                    items.push(...textFallback.split(/\s*[;；]\s*/).filter(Boolean));
                }
            }
            if (items.length === 0) continue;
            const ordered = Boolean((block as Record<string, unknown>).ordered)
                || rawType === "ol"
                || rawType === "ordered_list";
            normalized.push({
                id: blockId,
                type: "list",
                ordered,
                items,
            });
            continue;
        }

        if (blockType === "code") {
            const text = normalizeMultilineBlockText(
                (block as Record<string, unknown>).text
                || (block as Record<string, unknown>).code
                || "",
            );
            if (!text) continue;
            normalized.push({
                id: blockId,
                type: "code",
                text,
            });
            continue;
        }

        if (blockType === "reference") {
            const text = normalizeBlockText(block.text);
            if (!text) continue;
            const links = coerceBlockLinks((block as Record<string, unknown>).links);
            const anchorId = normalizeBlockText((block as Record<string, unknown>).anchor_id);
            normalized.push({
                id: blockId,
                type: "reference",
                text,
                links,
                anchorId: anchorId || undefined,
            });
            continue;
        }

        const text = normalizeBlockText(block.text);
        if (!text) continue;
        const inlineMarkdown = normalizeInlineMarkdownValue((block as Record<string, unknown>).inline_markdown);
        const inlineRuns = normalizeInlineRuns((block as Record<string, unknown>).inline_runs);
        normalized.push({
            id: blockId,
            type: blockType,
            text,
            inlineMarkdown: inlineMarkdown || undefined,
            inlineRuns: inlineRuns.length > 0 ? inlineRuns : undefined,
        });
    }

    const normalizedTitle = normalizeBlockText(articleTitle).toLowerCase();
    if (
        normalized.length > 0
        && normalized[0].type === "h1"
        && normalizeBlockText(normalized[0].text).toLowerCase() === normalizedTitle
    ) {
        normalized.shift();
    }

    return normalized;
}

function splitStructuredArticleSections(blocks: NormalizedArticleBlock[]): StructuredArticleSections {
    if (blocks.length === 0) {
        return {
            contentBlocks: [],
            referenceBlocks: [],
            referenceTitle: "References",
        };
    }

    const firstReferenceIndex = blocks.findIndex((block) => block.type === "reference");
    if (firstReferenceIndex === -1) {
        return {
            contentBlocks: blocks,
            referenceBlocks: [],
            referenceTitle: "References",
        };
    }

    const contentBlocks: NormalizedArticleBlock[] = [];
    const referenceBlocks: NormalizedArticleBlock[] = [];
    let referenceTitle = "References";

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (block.type === "reference") {
            referenceBlocks.push(block);
            continue;
        }

        const isHeading = block.type === "h1" || block.type === "h2" || block.type === "h3";
        if (index < firstReferenceIndex && isHeading && isReferenceHeadingText(block.text)) {
            referenceTitle = normalizeBlockText(block.text) || referenceTitle;
            continue;
        }

        contentBlocks.push(block);
    }

    return {
        contentBlocks,
        referenceBlocks,
        referenceTitle,
    };
}

function normalizeInlineRun(input: unknown): NormalizedInlineRun | null {
    if (!input || typeof input !== "object") {
        return null;
    }

    const rawRun = input as ArticleInlineRun;
    const rawType = normalizeBlockText(rawRun.type).toLowerCase();
    const normalizedType: NormalizedInlineRunType = rawType === "link"
        ? "link"
        : rawType === "math"
            ? "math"
            : rawType === "em"
                ? "em"
                : rawType === "strong"
                    ? "strong"
                    : rawType === "code"
                        ? "code"
                        : rawType === "sub"
                            ? "sub"
                            : rawType === "sup"
                                ? "sup"
                                : rawType === "underline"
                                    ? "underline"
                                    : rawType === "strike"
                                        ? "strike"
                                        : rawType === "smallcaps"
                                            ? "smallcaps"
                        : "text";

    const text = normalizeInlineRunText(rawRun.text);
    const href = normalizedType === "link" ? normalizeBlockText(rawRun.href) : "";
    const children = Array.isArray(rawRun.children)
        ? rawRun.children.map((child) => normalizeInlineRun(child)).filter((value): value is NormalizedInlineRun => Boolean(value))
        : [];

    if (normalizedType === "text" || normalizedType === "math") {
        if (!text) {
            return null;
        }
        return {
            type: normalizedType,
            text,
        };
    }

    if (normalizedType === "link") {
        if (!href) {
            if (!text) {
                return null;
            }
            return {
                type: "text",
                text,
            };
        }
        if (children.length === 0 && text) {
            return {
                type: "link",
                href,
                children: [{ type: "text", text }],
            };
        }
        if (children.length === 0) {
            return null;
        }
        return {
            type: "link",
            href,
            children,
        };
    }

    if (children.length === 0) {
        if (!text) {
            return null;
        }
        return {
            type: normalizedType,
            children: [{ type: "text", text }],
        };
    }

    return {
        type: normalizedType,
        children,
    };
}

function normalizeInlineRuns(input: unknown): NormalizedInlineRun[] {
    if (!Array.isArray(input)) {
        return [];
    }

    const runs = input
        .map((run) => normalizeInlineRun(run))
        .filter((value): value is NormalizedInlineRun => Boolean(value));

    const merged: NormalizedInlineRun[] = [];
    for (const run of runs) {
        if (run.type === "text" && run.text) {
            const previous = merged[merged.length - 1];
            if (previous?.type === "text" && previous.text !== undefined) {
                previous.text += run.text;
                continue;
            }
        }
        merged.push(run);
    }

    return merged;
}

function InlineRichText({
    markdown,
    onInternalReferenceNavigate,
    onInternalReferenceHoverChange,
    activeReferenceAnchorId,
}: {
    markdown: string;
    onInternalReferenceNavigate?: (href: string, sourceElement?: HTMLElement | null) => void;
    onInternalReferenceHoverChange?: (anchorId: string | null) => void;
    activeReferenceAnchorId?: string | null;
}) {
    const value = normalizeInlineMarkdownValue(markdown);
    if (!value) {
        return null;
    }

    return (
        <Markdown
            remarkPlugins={[remarkMath, remarkGfm]}
            rehypePlugins={[rehypeKatex]}
            components={{
                p: ({ children }) => <>{children}</>,
                a: ({ href, children }) => {
                    if (href?.startsWith("#")) {
                        const anchorId = extractInternalReferenceAnchorId(href);
                        const isActive = Boolean(anchorId) && activeReferenceAnchorId === anchorId;
                        return (
                            <button
                                type="button"
                                role="link"
                                className={`article-inline-link-button article-reader-link ${isActive ? ARTICLE_CITATION_SOURCE_ACTIVE_CLASS : ""}`.trim()}
                                data-href={href}
                                data-article-ref-target={anchorId || undefined}
                                onClick={(event) => {
                                    if (href) {
                                        onInternalReferenceNavigate?.(href, event.currentTarget);
                                    }
                                }}
                                onMouseEnter={() => onInternalReferenceHoverChange?.(anchorId || null)}
                                onMouseLeave={() => onInternalReferenceHoverChange?.(null)}
                                onFocus={() => onInternalReferenceHoverChange?.(anchorId || null)}
                                onBlur={() => onInternalReferenceHoverChange?.(null)}
                            >
                                {children}
                            </button>
                        );
                    }

                    return (
                        <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="article-reader-link"
                        >
                            {children}
                        </a>
                    );
                },
                code: ({ children }) => (
                    <code className="rounded bg-muted/40 px-1 py-0.5 font-mono text-[0.9em]">
                        {children}
                    </code>
                ),
                del: ({ children }) => <del>{children}</del>,
                sub: ({ children }) => <sub>{children}</sub>,
                sup: ({ children }) => <sup>{children}</sup>,
            }}
        >
            {value}
        </Markdown>
    );
}

function InlineRichRuns({
    runs,
    onInternalReferenceNavigate,
    onInternalReferenceHoverChange,
    activeReferenceAnchorId,
}: {
    runs: NormalizedInlineRun[];
    onInternalReferenceNavigate?: (href: string, sourceElement?: HTMLElement | null) => void;
    onInternalReferenceHoverChange?: (anchorId: string | null) => void;
    activeReferenceAnchorId?: string | null;
}) {
    const renderRun = useCallback((run: NormalizedInlineRun, path: string): ReactNode => {
        if (run.type === "text") {
            return run.text || null;
        }

        if (run.type === "math") {
            const value = normalizeInlineRunText(run.text);
            if (!value) {
                return null;
            }
            return (
                <span key={path} className="article-inline-math">
                    <Markdown
                        remarkPlugins={[remarkMath, remarkGfm]}
                        rehypePlugins={[rehypeKatex]}
                        components={{
                            p: ({ children }) => <>{children}</>,
                        }}
                    >
                        {`$${value}$`}
                    </Markdown>
                </span>
            );
        }

        const renderedChildren = (run.children || []).map((child, index) => renderRun(child, `${path}-${index}`));

        if (run.type === "link") {
            const href = normalizeBlockText(run.href);
            if (!href) {
                return <span key={path}>{renderedChildren}</span>;
            }
            if (href.startsWith("#")) {
                const anchorId = extractInternalReferenceAnchorId(href);
                const isActive = Boolean(anchorId) && activeReferenceAnchorId === anchorId;
                return (
                    <button
                        key={path}
                        type="button"
                        role="link"
                        className={`article-inline-link-button article-reader-link ${isActive ? ARTICLE_CITATION_SOURCE_ACTIVE_CLASS : ""}`.trim()}
                        data-href={href}
                        data-article-ref-target={anchorId || undefined}
                        onClick={(event) => onInternalReferenceNavigate?.(href, event.currentTarget)}
                        onMouseEnter={() => onInternalReferenceHoverChange?.(anchorId || null)}
                        onMouseLeave={() => onInternalReferenceHoverChange?.(null)}
                        onFocus={() => onInternalReferenceHoverChange?.(anchorId || null)}
                        onBlur={() => onInternalReferenceHoverChange?.(null)}
                    >
                        {renderedChildren}
                    </button>
                );
            }
            return (
                <a
                    key={path}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="article-reader-link"
                >
                    {renderedChildren}
                </a>
            );
        }

        if (run.type === "em") {
            return <em key={path}>{renderedChildren}</em>;
        }

        if (run.type === "strong") {
            return <strong key={path}>{renderedChildren}</strong>;
        }

        if (run.type === "code") {
            return (
                <code key={path} className="rounded bg-muted/40 px-1 py-0.5 font-mono text-[0.9em]">
                    {renderedChildren}
                </code>
            );
        }

        if (run.type === "sub") {
            return <sub key={path}>{renderedChildren}</sub>;
        }

        if (run.type === "sup") {
            return <sup key={path}>{renderedChildren}</sup>;
        }

        if (run.type === "underline") {
            return <span key={path} className="article-inline-underline">{renderedChildren}</span>;
        }

        if (run.type === "strike") {
            return <del key={path}>{renderedChildren}</del>;
        }

        if (run.type === "smallcaps") {
            return <span key={path} className="article-inline-smallcaps">{renderedChildren}</span>;
        }

        return <span key={path}>{renderedChildren}</span>;
    }, [activeReferenceAnchorId, onInternalReferenceHoverChange, onInternalReferenceNavigate]);

    if (runs.length === 0) {
        return null;
    }

    return <>{runs.map((run, index) => renderRun(run, `${index}`))}</>;
}

function shouldIgnorePreviewTrigger(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    return Boolean(target.closest("a, button, input, select, textarea, summary, [role='link']"));
}

function hasMeaningfulDomSelection(): boolean {
    if (typeof window === "undefined") {
        return false;
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return false;
    }
    return selection.toString().trim().length > 0;
}

function TableCellContent({
    cell,
    onInternalReferenceNavigate,
    onInternalReferenceHoverChange,
    activeReferenceAnchorId,
}: {
    cell: NormalizedTableCell;
    onInternalReferenceNavigate?: (href: string, sourceElement?: HTMLElement | null) => void;
    onInternalReferenceHoverChange?: (anchorId: string | null) => void;
    activeReferenceAnchorId?: string | null;
}) {
    if (cell.inlineRuns && cell.inlineRuns.length > 0) {
        return (
            <InlineRichRuns
                runs={cell.inlineRuns}
                onInternalReferenceNavigate={onInternalReferenceNavigate}
                onInternalReferenceHoverChange={onInternalReferenceHoverChange}
                activeReferenceAnchorId={activeReferenceAnchorId}
            />
        );
    }
    if (cell.inlineMarkdown) {
        return (
            <InlineRichText
                markdown={cell.inlineMarkdown}
                onInternalReferenceNavigate={onInternalReferenceNavigate}
                onInternalReferenceHoverChange={onInternalReferenceHoverChange}
                activeReferenceAnchorId={activeReferenceAnchorId}
            />
        );
    }
    return <>{cell.text}</>;
}

function ArticleImageFigure({
    imageSrc,
    altText,
    caption,
    previewMode = false,
    onOpenPreview,
    imageTestId,
}: {
    imageSrc: string;
    altText: string;
    caption?: string;
    previewMode?: boolean;
    onOpenPreview?: () => void;
    imageTestId?: string;
}) {
    const [focusCrop, setFocusCrop] = useState<ImageFocusCrop | null>(() => imageFocusCache.get(imageSrc) ?? null);
    const [naturalMetrics, setNaturalMetrics] = useState<ImageNaturalMetrics | null>(() => imageNaturalMetricsCache.get(imageSrc) ?? null);

    useEffect(() => {
        let isCancelled = false;
        if (!imageSrc) {
            setFocusCrop(null);
            return undefined;
        }

        if (imageFocusCache.has(imageSrc)) {
            setFocusCrop(imageFocusCache.get(imageSrc) ?? null);
            return undefined;
        }

        detectImageFocusCrop(imageSrc).then((nextFocusCrop) => {
            imageFocusCache.set(imageSrc, nextFocusCrop);
            if (!isCancelled) {
                setFocusCrop(nextFocusCrop);
            }
        });

        return () => {
            isCancelled = true;
        };
    }, [imageSrc]);

    useEffect(() => {
        let isCancelled = false;
        if (!imageSrc) {
            setNaturalMetrics(null);
            return undefined;
        }

        if (imageNaturalMetricsCache.has(imageSrc)) {
            setNaturalMetrics(imageNaturalMetricsCache.get(imageSrc) ?? null);
            return undefined;
        }

        loadImageNaturalMetrics(imageSrc).then((nextMetrics) => {
            imageNaturalMetricsCache.set(imageSrc, nextMetrics);
            if (!isCancelled) {
                setNaturalMetrics(nextMetrics);
            }
        });

        return () => {
            isCancelled = true;
        };
    }, [imageSrc]);

    const displayAspectRatio = focusCrop?.aspectRatio
        || (naturalMetrics && naturalMetrics.height > 0 ? naturalMetrics.width / naturalMetrics.height : null);
    const imageDisplayMode = useMemo(() => {
        if (!displayAspectRatio || !Number.isFinite(displayAspectRatio)) {
            return "balanced";
        }
        if (displayAspectRatio >= 1.45) {
            return "wide";
        }
        if (displayAspectRatio <= 0.88) {
            return "tall";
        }
        return "balanced";
    }, [displayAspectRatio]);

    const handlePreviewIntent = (event: ReactMouseEvent<HTMLElement>) => {
        if (previewMode || !onOpenPreview || shouldIgnorePreviewTrigger(event.target) || hasMeaningfulDomSelection()) {
            return;
        }
        onOpenPreview();
    };

    const imageContent = (
        <div
            className={`article-image-stage article-image-stage-${imageDisplayMode} ${focusCrop ? "article-image-stage-focused" : ""}`.trim()}
            style={focusCrop ? { aspectRatio: `${focusCrop.aspectRatio}` } : undefined}
        >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src={imageSrc}
                alt={altText}
                loading={previewMode ? "eager" : "lazy"}
                decoding="async"
                crossOrigin="anonymous"
                className={`article-image-element ${focusCrop ? "article-image-element-focused" : ""}`.trim()}
                style={focusCrop ? {
                    objectPosition: `${focusCrop.objectPositionX.toFixed(2)}% ${focusCrop.objectPositionY.toFixed(2)}%`,
                } : undefined}
                data-testid={imageTestId}
            />
        </div>
    );

    return (
        <figure
            className={[
                previewMode ? "article-preview-image-block-shell" : "article-content-block article-image-figure",
                "relative",
            ].join(" ")}
            data-article-image-mode={imageDisplayMode}
            data-testid={previewMode ? "article-preview-image-block" : "article-image-block"}
        >
            <div className="article-image-shell">
                {previewMode ? (
                    <div className="article-image-hit-area">{imageContent}</div>
                ) : (
                    <div
                        className="article-image-hit-area"
                        onDoubleClick={handlePreviewIntent}
                    >
                        {imageContent}
                    </div>
                )}
                {!previewMode && (
                    <div className="article-image-actions">
                        <button
                            type="button"
                            className="article-image-action"
                            onClick={() => onOpenPreview?.()}
                        >
                            Zoom
                        </button>
                        <a
                            href={imageSrc}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="article-image-action"
                            onClick={(event) => event.stopPropagation()}
                        >
                            Original
                        </a>
                    </div>
                )}
            </div>
            {caption && !previewMode && (
                <figcaption className="article-reader-caption">
                    {caption}
                </figcaption>
            )}
        </figure>
    );
}

function EquationBlockPanel({
    block,
    previewMode = false,
    onOpenPreview,
}: {
    block: Pick<NormalizedArticleBlock, "id" | "equationTex" | "equationNumber">;
    previewMode?: boolean;
    onOpenPreview?: () => void;
}) {
    if (!block.equationTex) {
        return null;
    }
    const equationMarkdown = buildDisplayMathMarkdown(block.equationTex);
    const handlePreviewIntent = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (previewMode || !onOpenPreview || shouldIgnorePreviewTrigger(event.target) || hasMeaningfulDomSelection()) {
            return;
        }
        onOpenPreview();
    };

    return (
        <div
            className={[
                previewMode ? "article-preview-equation-shell" : "article-content-block",
                "article-equation-card",
                !previewMode ? "article-previewable-block" : "",
                "relative",
                "overflow-visible",
                previewMode ? "text-[17px] leading-9" : "text-[15px] leading-8",
                "text-foreground/95",
            ].join(" ")}
            data-testid={previewMode ? "article-preview-equation-block" : "article-equation-block"}
            onDoubleClick={previewMode ? undefined : handlePreviewIntent}
        >
            {!previewMode && onOpenPreview && (
                <div className="article-block-actions">
                    <button
                        type="button"
                        className="article-block-action"
                        onClick={(event) => {
                            event.stopPropagation();
                            onOpenPreview();
                        }}
                    >
                        Zoom
                    </button>
                </div>
            )}
            <div
                className={
                    block.equationNumber
                        ? "article-equation-surface grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4"
                        : "article-equation-surface flex justify-center"
                }
            >
                {block.equationNumber && <div aria-hidden />}
                <div className="min-w-0 justify-self-center text-center [&_.katex-display]:m-0 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1">
                    {equationMarkdown ? (
                        <Markdown
                            remarkPlugins={[[remarkMath, { singleDollarTextMath: false }], remarkGfm]}
                            rehypePlugins={[rehypeKatex]}
                            components={{
                                p: ({ children }) => <>{children}</>,
                            }}
                        >
                            {equationMarkdown}
                        </Markdown>
                    ) : (
                        <code className="font-mono text-[13px]">{block.equationTex}</code>
                    )}
                </div>
                {block.equationNumber && (
                    <div className="justify-self-end whitespace-nowrap font-mono text-[12px] text-muted-foreground/90">
                        {block.equationNumber}
                    </div>
                )}
            </div>
            {block.equationNumber && (
                <div className="sr-only">
                    Equation number {block.equationNumber}
                </div>
            )}
        </div>
    );
}

function StructuredTableFigure({
    block,
    previewMode = false,
    onOpenPreview,
    onInternalReferenceNavigate,
    onInternalReferenceHoverChange,
    activeReferenceAnchorId,
}: {
    block: Pick<NormalizedArticleBlock, "id" | "caption" | "notes" | "headerRows" | "bodyRows" | "columns" | "rows">;
    previewMode?: boolean;
    onOpenPreview?: () => void;
    onInternalReferenceNavigate?: (href: string, sourceElement?: HTMLElement | null) => void;
    onInternalReferenceHoverChange?: (anchorId: string | null) => void;
    activeReferenceAnchorId?: string | null;
}) {
    const headerRows = block.headerRows || [];
    const bodyRows = block.bodyRows || [];
    const hasTableHead = headerRows.length > 0;
    const tableLayout = getStructuredTableColumnLayout(block as NormalizedArticleBlock);
    const tableColumnCount = tableLayout.columnCount;
    const tableMinWidthRem = previewMode ? Math.max(tableLayout.minWidthRem, 40) : null;
    const handlePreviewIntent = (event: ReactMouseEvent<HTMLElement>) => {
        if (previewMode || !onOpenPreview || shouldIgnorePreviewTrigger(event.target) || hasMeaningfulDomSelection()) {
            return;
        }
        onOpenPreview();
    };

    return (
        <figure
            className={[
                previewMode ? "article-preview-table-block-shell" : "article-content-block",
                "article-reader-panel",
                !previewMode ? "article-previewable-block" : "",
                "relative",
                "overflow-hidden",
                "bg-background",
            ].join(" ")}
            data-testid={previewMode ? "article-preview-table-block" : "article-table-block"}
            onDoubleClick={previewMode ? undefined : handlePreviewIntent}
        >
            {!previewMode && onOpenPreview && (
                <div className="article-block-actions">
                    <button
                        type="button"
                        className="article-block-action"
                        onClick={(event) => {
                            event.stopPropagation();
                            onOpenPreview();
                        }}
                    >
                        Zoom
                    </button>
                </div>
            )}
            {block.caption && (
                <figcaption className="article-reader-caption border-b border-border/50">
                    {block.caption}
                </figcaption>
            )}
            <div className={`article-reader-table-shell ${previewMode ? "article-reader-table-shell-preview" : ""}`.trim()}>
                <table
                    className="article-reader-table"
                    style={tableMinWidthRem ? { minWidth: `${tableMinWidthRem}rem` } : undefined}
                    data-testid={previewMode ? "article-preview-table" : "article-table"}
                >
                    <colgroup>
                        {Array.from({ length: tableColumnCount }, (_, columnIndex) => (
                            <col
                                key={`${block.id}-col-${columnIndex}`}
                                style={{ width: tableLayout.columnWidths[columnIndex] }}
                            />
                        ))}
                    </colgroup>
                    {hasTableHead && (
                        <thead className="article-reader-table-head">
                            {headerRows.map((row, rowIndex) => (
                                <tr key={`${block.id}-head-row-${rowIndex}`} className="article-reader-table-row">
                                    {row.map((cell, cellIndex) => (
                                        <th
                                            key={`${block.id}-head-cell-${rowIndex}-${cellIndex}`}
                                            className="article-reader-table-header-cell"
                                            colSpan={cell.colSpan || 1}
                                            rowSpan={cell.rowSpan || 1}
                                            scope={cell.scope || "col"}
                                            data-testid="article-table-cell"
                                            data-article-table-cell-kind={isCompactNumericTableText(cell.text) ? "numeric" : "text"}
                                        >
                                            <TableCellContent
                                                cell={cell}
                                                onInternalReferenceNavigate={onInternalReferenceNavigate}
                                                onInternalReferenceHoverChange={onInternalReferenceHoverChange}
                                                activeReferenceAnchorId={activeReferenceAnchorId}
                                            />
                                        </th>
                                    ))}
                                </tr>
                            ))}
                        </thead>
                    )}
                    <tbody>
                        {bodyRows.map((row, rowIndex) => (
                            <tr key={`${block.id}-row-${rowIndex}`} className="article-reader-table-row">
                                {row.map((cell, cellIndex) => {
                                    const CellTag = cell.isHeader ? "th" : "td";
                                    return (
                                        <CellTag
                                            key={`${block.id}-cell-${rowIndex}-${cellIndex}`}
                                            className={cell.isHeader ? "article-reader-table-row-header-cell" : "article-reader-table-cell"}
                                            colSpan={cell.colSpan || 1}
                                            rowSpan={cell.rowSpan || 1}
                                            scope={cell.isHeader ? (cell.scope || "row") : undefined}
                                            data-testid="article-table-cell"
                                            data-article-table-cell-kind={isCompactNumericTableText(cell.text) ? "numeric" : cell.isHeader ? "row-header" : "text"}
                                        >
                                            <TableCellContent
                                                cell={cell}
                                                onInternalReferenceNavigate={onInternalReferenceNavigate}
                                                onInternalReferenceHoverChange={onInternalReferenceHoverChange}
                                                activeReferenceAnchorId={activeReferenceAnchorId}
                                            />
                                        </CellTag>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {block.notes && block.notes.length > 0 && (
                <figcaption className="article-reader-caption border-t border-border/50">
                    {block.notes.map((note, noteIndex) => (
                        <p key={`${block.id}-note-${noteIndex}`}>{note}</p>
                    ))}
                </figcaption>
            )}
        </figure>
    );
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

function areOverlayRectsEqual(a: SelectionOverlayRect[], b: SelectionOverlayRect[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
        const left = a[index];
        const right = b[index];
        if (
            Math.abs(left.left - right.left) > 0.5
            || Math.abs(left.top - right.top) > 0.5
            || Math.abs(left.width - right.width) > 0.5
            || Math.abs(left.height - right.height) > 0.5
        ) {
            return false;
        }
    }
    return true;
}

function mergeOverlayRects(rects: SelectionOverlayRect[]): SelectionOverlayRect[] {
    if (rects.length <= 1) return rects;

    const sorted = [...rects].sort((a, b) => {
        const centerDiff = Math.abs((a.top + a.height / 2) - (b.top + b.height / 2));
        if (centerDiff > 3) {
            return a.top - b.top;
        }
        return a.left - b.left;
    });

    const lines: SelectionOverlayRect[][] = [];
    for (const rect of sorted) {
        const rectCenter = rect.top + rect.height / 2;
        const currentLine = lines[lines.length - 1];
        if (!currentLine) {
            lines.push([{ ...rect }]);
            continue;
        }

        const lineCenter = currentLine.reduce((sum, current) => sum + current.top + current.height / 2, 0) / currentLine.length;
        const lineHeight = Math.max(...currentLine.map((current) => current.height), rect.height);
        if (Math.abs(rectCenter - lineCenter) <= Math.max(4, lineHeight * 0.45)) {
            currentLine.push({ ...rect });
            continue;
        }

        lines.push([{ ...rect }]);
    }

    return lines.map((lineRects) => {
        const left = Math.min(...lineRects.map((rect) => rect.left));
        const top = Math.min(...lineRects.map((rect) => rect.top));
        const right = Math.max(...lineRects.map((rect) => rect.left + rect.width));
        const bottom = Math.max(...lineRects.map((rect) => rect.top + rect.height));
        return {
            left,
            top,
            width: right - left,
            height: bottom - top,
        };
    });
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

function computeSelectionOverlayRects(range: Range, container: HTMLDivElement): SelectionOverlayRect[] {
    const containerRect = container.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
        .map((clientRect) => toOverlayRect(clientRect, containerRect, container))
        .filter((value): value is SelectionOverlayRect => Boolean(value));
    if (rects.length > 0) {
        return mergeOverlayRects(rects);
    }

    const fallbackRect = toOverlayRect(range.getBoundingClientRect(), containerRect, container);
    return fallbackRect ? [fallbackRect] : [];
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
    const [isSelectionInProgress, setIsSelectionInProgress] = useState(false);
    const [referencesExpanded, setReferencesExpanded] = useState(false);
    const [focusedReferenceAnchorId, setFocusedReferenceAnchorId] = useState<string | null>(null);
    const [hoveredReferenceAnchorId, setHoveredReferenceAnchorId] = useState<string | null>(null);
    const [referenceNavigation, setReferenceNavigation] = useState<ReferenceNavigationState | null>(null);
    const [pendingReferenceAnchorId, setPendingReferenceAnchorId] = useState<string | null>(null);
    const [activePreview, setActivePreview] = useState<ArticlePreviewState | null>(null);
    const [previewZoom, setPreviewZoom] = useState(1);
    const [previewSelectableText, setPreviewSelectableText] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const selectionOverlayLayerRef = useRef<HTMLDivElement | null>(null);
    const selectionOverlayRectsRef = useRef<SelectionOverlayRect[]>([]);
    const previewContentRef = useRef<HTMLDivElement | null>(null);
    const previewTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
    const progressFillRef = useRef<HTMLDivElement | null>(null);
    const progressValueRef = useRef<HTMLSpanElement | null>(null);
    const activeTocAnchorIdRef = useRef<string | null>(null);
    const tocButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
    const headingOffsetCacheRef = useRef<Array<{ anchorId: string; top: number }>>([]);
    const scrollTelemetryFrameRef = useRef<number | null>(null);
    const selectionInProgressRef = useRef(false);
    const citationFocusRef = useRef<HTMLElement | null>(null);
    const citationFocusTimerRef = useRef<number | null>(null);
    const citationSourceRef = useRef<HTMLElement | null>(null);
    const citationSourceReturnTimerRef = useRef<number | null>(null);
    const markdownMode = useMemo(() => isMarkdownContent(contentFormat), [contentFormat]);
    const structuredBlocks = useMemo(
        () => (markdownMode ? [] : normalizeArticleBlocks(articleBlocks, sourceUrl, title)),
        [articleBlocks, markdownMode, sourceUrl, title],
    );
    const structuredSections = useMemo(
        () => splitStructuredArticleSections(structuredBlocks),
        [structuredBlocks],
    );
    const hasStructuredBlocks = structuredBlocks.length > 0;
    const hasReferenceBlocks = structuredSections.referenceBlocks.length > 0;
    const tocItems = useMemo<ArticleTocItem[]>(() => (
        structuredSections.contentBlocks.flatMap((block) => {
            const level = getHeadingLevel(block.type);
            const text = normalizeBlockText(block.text);
            if (!level || !text) {
                return [];
            }
            return [{
                blockId: block.id,
                anchorId: getArticleHeadingAnchorId(block.id),
                text,
                level,
            }];
        })
    ), [structuredSections.contentBlocks]);
    const hasWideContentBlocks = useMemo(
        () => structuredSections.contentBlocks.some((block) => (
            block.type === "table"
            || block.type === "image"
            || block.type === "equation"
            || block.type === "code"
        )),
        [structuredSections.contentBlocks],
    );
    const showToc = tocItems.length >= 2;
    const activeReferenceAnchorId = hoveredReferenceAnchorId || focusedReferenceAnchorId || referenceNavigation?.anchorId || null;
    const clampPreviewZoom = useCallback((value: number) => {
        if (Number.isNaN(value) || !Number.isFinite(value)) {
            return 1;
        }
        return Math.max(0.6, Math.min(3.5, Number(value.toFixed(2))));
    }, []);
    const openPreview = useCallback((nextPreview: ArticlePreviewState) => {
        setActivePreview(nextPreview);
        setPreviewZoom(1);
        setPreviewSelectableText(null);
    }, []);
    const closePreview = useCallback(() => {
        setActivePreview(null);
        setPreviewZoom(1);
        setPreviewSelectableText(null);
    }, []);
    const adjustPreviewZoom = useCallback((delta: number) => {
        setPreviewZoom((current) => clampPreviewZoom(current + delta));
    }, [clampPreviewZoom]);
    const selectPreviewText = useCallback(() => {
        const previewRoot = previewContentRef.current;
        if (!previewRoot) {
            return;
        }
        const rawText = previewRoot instanceof HTMLElement
            ? (previewRoot.innerText || previewRoot.textContent || "")
            : (previewRoot.textContent || "");
        const normalizedText = rawText.replace(/\n{3,}/g, "\n\n").trim();
        if (!normalizedText) {
            return;
        }
        setPreviewSelectableText(normalizedText);
    }, []);
    const handlePreviewWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
        event.preventDefault();
        const delta = event.deltaY < 0 ? 0.14 : -0.14;
        setPreviewZoom((current) => clampPreviewZoom(current + delta));
    }, [clampPreviewZoom]);

    const paragraphs = useMemo(
        () => (markdownMode || hasStructuredBlocks ? [] : splitArticleParagraphs(rawContent || "")),
        [rawContent, markdownMode, hasStructuredBlocks],
    );
    const layoutMaxWidthClass = showToc
        ? (hasWideContentBlocks ? "max-w-[94rem]" : "max-w-[88rem]")
        : (hasWideContentBlocks ? "max-w-[84rem]" : "max-w-[78rem]");
    const renderSelectionOverlayRects = useCallback((nextRects: SelectionOverlayRect[]) => {
        const overlayLayer = selectionOverlayLayerRef.current;
        if (!overlayLayer || areOverlayRectsEqual(selectionOverlayRectsRef.current, nextRects)) {
            selectionOverlayRectsRef.current = nextRects;
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const [index, rect] of nextRects.entries()) {
            const span = document.createElement("span");
            span.className = "absolute rounded-[2px] bg-sky-300/55 dark:bg-sky-500/35";
            span.dataset.testid = "article-selection-rect";
            span.style.left = `${rect.left}px`;
            span.style.top = `${rect.top}px`;
            span.style.width = `${rect.width}px`;
            span.style.height = `${rect.height}px`;
            span.setAttribute("data-article-selection-index", `${index}`);
            fragment.appendChild(span);
        }

        overlayLayer.replaceChildren(fragment);
        selectionOverlayRectsRef.current = nextRects;
    }, []);
    const clearSelectionUi = useCallback(() => {
        renderSelectionOverlayRects([]);
        setSelectedText("");
        setTooltipPosition(null);
        setSelectedContextBefore(null);
        setSelectedContextAfter(null);
    }, [renderSelectionOverlayRects, setSelectedText, setTooltipPosition]);

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
        setFocusedReferenceAnchorId(null);
    }, []);

    const clearSourceCitationReturnFlash = useCallback(() => {
        if (citationSourceReturnTimerRef.current !== null) {
            window.clearTimeout(citationSourceReturnTimerRef.current);
            citationSourceReturnTimerRef.current = null;
        }
        const currentSource = citationSourceRef.current;
        if (currentSource) {
            currentSource.classList.remove(ARTICLE_CITATION_SOURCE_RETURN_CLASS);
        }
    }, []);

    const setCitationFocus = useCallback((target: HTMLElement, anchorId?: string) => {
        clearCitationFocus();
        target.classList.add(...ARTICLE_CITATION_FOCUS_CLASSES);
        target.setAttribute(ARTICLE_CITATION_FOCUS_ATTR, "true");
        citationFocusRef.current = target;
        setFocusedReferenceAnchorId(anchorId || target.id || null);
        citationFocusTimerRef.current = window.setTimeout(() => {
            clearCitationFocus();
        }, ARTICLE_CITATION_FOCUS_TIMEOUT_MS);
    }, [clearCitationFocus]);

    const handleInternalReferenceNavigate = useCallback((href: string, sourceElement?: HTMLElement | null) => {
        const normalizedHref = normalizeBlockText(href);
        if (!normalizedHref.startsWith("#")) {
            return;
        }

        const anchorId = normalizedHref.slice(1);
        if (!anchorId) {
            return;
        }

        clearSourceCitationReturnFlash();
        if (sourceElement instanceof HTMLElement) {
            citationSourceRef.current = sourceElement;
        }

        const container = containerRef.current;
        setReferenceNavigation({
            anchorId,
            returnScrollTop: container?.scrollTop || 0,
            canReturn: sourceElement instanceof HTMLElement,
        });
        setPendingReferenceAnchorId(anchorId);
        if (structuredSections.referenceBlocks.length > REFERENCE_PREVIEW_COUNT) {
            setReferencesExpanded(true);
        }
        if (typeof window !== "undefined" && window.location.hash !== normalizedHref) {
            window.history.replaceState(null, "", normalizedHref);
        }
    }, [clearSourceCitationReturnFlash, structuredSections.referenceBlocks.length]);

    const handleReturnFromReference = useCallback(() => {
        const container = containerRef.current;
        const nextTop = referenceNavigation?.returnScrollTop ?? 0;

        if (container) {
            container.scrollTo({
                top: nextTop,
                behavior: "smooth",
            });
        }

        if (typeof window !== "undefined" && window.location.hash.startsWith("#article-ref-")) {
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        }

        clearCitationFocus();
        setPendingReferenceAnchorId(null);
        setHoveredReferenceAnchorId(null);
        setReferenceNavigation(null);

        const currentSource = citationSourceRef.current;
        if (currentSource) {
            currentSource.classList.add(ARTICLE_CITATION_SOURCE_RETURN_CLASS);
            currentSource.focus({ preventScroll: true });
            citationSourceReturnTimerRef.current = window.setTimeout(() => {
                clearSourceCitationReturnFlash();
            }, 2200);
        }
    }, [clearCitationFocus, clearSourceCitationReturnFlash, referenceNavigation]);

    const updateScrollProgressDom = useCallback((nextPercent: number) => {
        const fillElement = progressFillRef.current;
        const valueElement = progressValueRef.current;
        const clampedPercent = Math.max(0, Math.min(100, Math.round(nextPercent)));

        if (fillElement) {
            const nextHeight = `${clampedPercent}%`;
            if (fillElement.style.height !== nextHeight) {
                fillElement.style.height = nextHeight;
            }
        }

        if (valueElement) {
            const nextLabel = `${clampedPercent}%`;
            if (valueElement.textContent !== nextLabel) {
                valueElement.textContent = nextLabel;
            }
        }
    }, []);

    const applyActiveTocAnchor = useCallback((anchorId: string | null) => {
        const currentAnchorId = activeTocAnchorIdRef.current;
        if (currentAnchorId === anchorId) {
            return;
        }

        if (currentAnchorId) {
            const previousButton = tocButtonRefs.current.get(currentAnchorId);
            previousButton?.classList.remove("article-toc-link-active");
        }

        if (anchorId) {
            const nextButton = tocButtonRefs.current.get(anchorId);
            nextButton?.classList.add("article-toc-link-active");
        }

        activeTocAnchorIdRef.current = anchorId;
    }, []);

    const measureHeadingOffsets = useCallback(() => {
        const container = containerRef.current;
        if (!container || tocItems.length === 0) {
            headingOffsetCacheRef.current = [];
            applyActiveTocAnchor(null);
            return;
        }

        const containerRect = container.getBoundingClientRect();
        headingOffsetCacheRef.current = tocItems
            .map((item) => {
                const node = document.getElementById(item.anchorId);
                if (!(node instanceof HTMLElement)) {
                    return null;
                }
                return {
                    anchorId: item.anchorId,
                    top: node.getBoundingClientRect().top - containerRect.top + container.scrollTop,
                };
            })
            .filter((value): value is { anchorId: string; top: number } => Boolean(value))
            .sort((left, right) => left.top - right.top);

        if (headingOffsetCacheRef.current.length > 0 && !activeTocAnchorIdRef.current) {
            applyActiveTocAnchor(headingOffsetCacheRef.current[0].anchorId);
        }
    }, [applyActiveTocAnchor, tocItems]);

    const updateSelectionOverlayRectsState = useCallback((nextRects: SelectionOverlayRect[], perfMs?: number) => {
        const container = containerRef.current;
        if (container && typeof perfMs === "number") {
            container.setAttribute("data-article-last-selection-ms", perfMs.toFixed(2));
            container.setAttribute("data-article-last-selection-rect-count", `${nextRects.length}`);
        }
        renderSelectionOverlayRects(nextRects);
    }, [renderSelectionOverlayRects]);

    const handleTocNavigate = useCallback((anchorId: string) => {
        const normalizedAnchorId = normalizeBlockText(anchorId);
        if (!normalizedAnchorId) {
            return;
        }

        const target = document.getElementById(normalizedAnchorId);
        if (!(target instanceof HTMLElement)) {
            return;
        }

        applyActiveTocAnchor(normalizedAnchorId);
        target.scrollIntoView({
            behavior: "smooth",
            block: "start",
            inline: "nearest",
        });

        if (typeof window !== "undefined" && window.location.hash !== `#${normalizedAnchorId}`) {
            window.history.replaceState(null, "", `#${normalizedAnchorId}`);
        }
    }, [applyActiveTocAnchor]);

    const handleArticleClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        const target = event.target;
        const targetElement = target instanceof Element
            ? target
            : target instanceof Node
                ? target.parentElement
                : null;
        const link = targetElement?.closest('a[href^="#article-ref-"]');
        if (!(link instanceof HTMLAnchorElement)) {
            return;
        }
        handleInternalReferenceNavigate(link.getAttribute("href") || "");
    }, [handleInternalReferenceNavigate]);

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

        const selectionStart = typeof performance !== "undefined" ? performance.now() : 0;
        const nextOverlayRects = computeSelectionOverlayRects(range, container);
        const selectionDuration = typeof performance !== "undefined" ? performance.now() - selectionStart : undefined;
        updateSelectionOverlayRectsState(nextOverlayRects, selectionDuration);
        try {
            domSelection.removeAllRanges();
        } catch {
            // Ignore browser-specific selection cleanup errors.
        }

        return true;
    }, [setSelectedText, setTooltipPosition, updateSelectionOverlayRectsState]);

    const updateSelectionOverlayFromDom = useCallback(() => {
        const container = containerRef.current;
        const domSelection = window.getSelection();
        if (!container || !domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) {
            updateSelectionOverlayRectsState([]);
            return false;
        }

        const range = domSelection.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)
            && !container.contains(range.startContainer)
            && !container.contains(range.endContainer)) {
            updateSelectionOverlayRectsState([]);
            return false;
        }

        const normalizedSelected = normalizeSelectionText(domSelection.toString());
        if (!normalizedSelected) {
            updateSelectionOverlayRectsState([]);
            return false;
        }

        const selectionStart = typeof performance !== "undefined" ? performance.now() : 0;
        const nextOverlayRects = computeSelectionOverlayRects(range, container);
        const selectionDuration = typeof performance !== "undefined" ? performance.now() - selectionStart : undefined;
        updateSelectionOverlayRectsState(nextOverlayRects, selectionDuration);
        return true;
    }, [updateSelectionOverlayRectsState]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const onPointerDown = () => {
            selectionInProgressRef.current = true;
            setIsSelectionInProgress(true);
            updateSelectionOverlayRectsState([]);
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
    }, [applyDomSelection, updateSelectionOverlayRectsState]);

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
        if (!previewSelectableText) {
            return;
        }
        const textArea = previewTextAreaRef.current;
        if (!textArea) {
            return;
        }
        window.requestAnimationFrame(() => {
            textArea.focus();
            textArea.select();
        });
    }, [previewSelectableText]);

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
        clearSourceCitationReturnFlash();
        setHoveredReferenceAnchorId(null);
        setReferenceNavigation(null);
        setPendingReferenceAnchorId(null);
        setActivePreview(null);
        setPreviewZoom(1);
    }, [rawContent, clearSelectionUi, clearCitationFocus, clearSourceCitationReturnFlash]);

    useEffect(() => {
        setReferencesExpanded(structuredSections.referenceBlocks.length <= REFERENCE_PREVIEW_COUNT);
    }, [structuredSections.referenceBlocks.length, title, sourceUrl]);

    useEffect(() => {
        if (!pendingReferenceAnchorId) {
            return undefined;
        }

        const needsExpansion = structuredSections.referenceBlocks.length > REFERENCE_PREVIEW_COUNT;
        if (needsExpansion && !referencesExpanded) {
            return undefined;
        }

        const rafId = window.requestAnimationFrame(() => {
            const target = document.getElementById(pendingReferenceAnchorId);
            if (!(target instanceof HTMLElement)) {
                return;
            }

            target.scrollIntoView({
                behavior: "smooth",
                block: "center",
                inline: "nearest",
            });
            setCitationFocus(target, pendingReferenceAnchorId);
            setPendingReferenceAnchorId(null);
        });

        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [
        pendingReferenceAnchorId,
        referencesExpanded,
        setCitationFocus,
        structuredSections.referenceBlocks.length,
    ]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return undefined;
        }

        const revealFromHash = () => {
            const hash = window.location.hash;
            if (hash.startsWith("#article-ref-")) {
                handleInternalReferenceNavigate(hash);
                return;
            }
            if (hash.startsWith("#article-heading-")) {
                handleTocNavigate(hash.slice(1));
            }
        };

        revealFromHash();
        window.addEventListener("hashchange", revealFromHash);
        return () => {
            window.removeEventListener("hashchange", revealFromHash);
        };
    }, [handleInternalReferenceNavigate, handleTocNavigate]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const runScrollTelemetry = () => {
            scrollTelemetryFrameRef.current = null;
            const startTime = typeof performance !== "undefined" ? performance.now() : 0;

            const maxScrollable = Math.max(1, container.scrollHeight - container.clientHeight);
            const nextPercent = Math.round(Math.max(0, Math.min(1, container.scrollTop / maxScrollable)) * 100);
            updateScrollProgressDom(nextPercent);

            const headingOffsets = headingOffsetCacheRef.current;
            if (headingOffsets.length === 0) {
                applyActiveTocAnchor(null);
            } else {
                const threshold = container.scrollTop + 132;
                let nextActive = headingOffsets[0].anchorId;
                for (const headingOffset of headingOffsets) {
                    if (headingOffset.top <= threshold) {
                        nextActive = headingOffset.anchorId;
                    } else {
                        break;
                    }
                }
                applyActiveTocAnchor(nextActive);
            }

            if (typeof performance !== "undefined") {
                container.setAttribute("data-article-last-scroll-ms", (performance.now() - startTime).toFixed(2));
                container.setAttribute("data-article-last-scroll-percent", `${nextPercent}`);
            }
        };

        const scheduleScrollTelemetry = () => {
            if (scrollTelemetryFrameRef.current !== null) {
                return;
            }
            scrollTelemetryFrameRef.current = window.requestAnimationFrame(runScrollTelemetry);
        };

        const handleResize = () => {
            measureHeadingOffsets();
            scheduleScrollTelemetry();
        };

        measureHeadingOffsets();
        scheduleScrollTelemetry();
        container.addEventListener("scroll", scheduleScrollTelemetry, { passive: true });
        window.addEventListener("resize", handleResize);
        return () => {
            if (scrollTelemetryFrameRef.current !== null) {
                window.cancelAnimationFrame(scrollTelemetryFrameRef.current);
                scrollTelemetryFrameRef.current = null;
            }
            container.removeEventListener("scroll", scheduleScrollTelemetry);
            window.removeEventListener("resize", handleResize);
        };
    }, [applyActiveTocAnchor, measureHeadingOffsets, rawContent, markdownMode, tocItems, updateScrollProgressDom]);

    useEffect(() => {
        return () => {
            clearCitationFocus();
            clearSourceCitationReturnFlash();
        };
    }, [clearCitationFocus, clearSourceCitationReturnFlash]);

    useEffect(() => {
        if (!activePreview) {
            return undefined;
        }

        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                closePreview();
            }
        };

        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [activePreview, closePreview]);

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
            className="article-selection-scope relative h-full overflow-auto px-4 pb-10 pt-6 md:px-6 lg:px-8 xl:px-10"
            id="article-container"
            onClickCapture={handleArticleClickCapture}
        >
            <div ref={selectionOverlayLayerRef} aria-hidden className="pointer-events-none absolute inset-0 z-[8]" />
            <div className={`mx-auto flex ${layoutMaxWidthClass} gap-3 sm:gap-4 md:gap-5 lg:gap-6`}>
                <aside className="shrink-0" aria-hidden>
                    <div
                        className="sticky top-6 flex h-[calc(100vh-7rem)] min-h-[18rem] w-4 flex-col items-center justify-between py-2 md:top-8 md:w-5"
                        data-testid="article-progress-rail"
                    >
                        <span className="article-progress-label">Read</span>
                        <div className="article-progress-track">
                            <div
                                className="article-progress-fill"
                                data-testid="article-progress-fill"
                                ref={progressFillRef}
                                style={{ height: "0%" }}
                            />
                        </div>
                        <span className="article-progress-value" data-testid="article-reading-progress" ref={progressValueRef}>
                            0%
                        </span>
                    </div>
                </aside>
                {showToc && (
                    <aside className="article-toc-rail hidden shrink-0 lg:block" data-testid="article-toc-rail">
                        <div className="article-toc-shell">
                            <p className="article-toc-label">On this page</p>
                            <nav aria-label="Article table of contents">
                                <ol className="article-toc-list">
                                    {tocItems.map((item) => (
                                        <li key={item.anchorId}>
                                            <button
                                                type="button"
                                                className={`article-toc-link article-toc-level-${item.level}`.trim()}
                                                data-testid="article-toc-link"
                                                data-article-toc-target={item.anchorId}
                                                ref={(node) => {
                                                    if (node) {
                                                        tocButtonRefs.current.set(item.anchorId, node);
                                                    } else {
                                                        tocButtonRefs.current.delete(item.anchorId);
                                                    }
                                                }}
                                                onClick={() => handleTocNavigate(item.anchorId)}
                                            >
                                                {item.text}
                                            </button>
                                        </li>
                                    ))}
                                </ol>
                            </nav>
                        </div>
                    </aside>
                )}
                <div className="article-reader-main-column">
                <header className="border-b border-border/70 pb-7">
                    <div className="article-reader-title-shell space-y-3">
                        {title && <h1 className="text-balance text-[2.15rem] font-semibold leading-[1.18] tracking-[-0.022em]">{title}</h1>}
                        {sourceUrl && (
                            <a
                                href={sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[13px] text-muted-foreground underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:text-foreground"
                            >
                                Open original source
                            </a>
                        )}
                    </div>
                </header>

                {(rawContent || "").trim() ? (
                    <article className="article-reader-flow article-reader-prose pb-14 text-foreground/95">
                        {markdownMode ? (
                            <Markdown
                                remarkPlugins={[[remarkMath, { singleDollarTextMath: false }], remarkGfm]}
                                rehypePlugins={[rehypeKatex]}
                                components={{
                                    h1: ({ children }) => <h2 className="article-reader-heading-1">{children}</h2>,
                                    h2: ({ children }) => <h3 className="article-reader-heading-2">{children}</h3>,
                                    h3: ({ children }) => <h4 className="article-reader-heading-3">{children}</h4>,
                                    p: ({ children }) => <p className="article-reader-paragraph">{children}</p>,
                                    blockquote: ({ children }) => (
                                        <blockquote className="article-content-block article-reader-quote">
                                            {children}
                                        </blockquote>
                                    ),
                                    ul: ({ children }) => <ul className="article-content-block article-reader-list list-disc">{children}</ul>,
                                    ol: ({ children }) => <ol className="article-content-block article-reader-list list-decimal">{children}</ol>,
                                    img: ({ src, alt }) => (
                                        <ArticleImageFigure
                                            imageSrc={resolveArticleImageUrl(src || "", sourceUrl)}
                                            altText={alt || "Article image"}
                                            onOpenPreview={() => {
                                                const resolvedSrc = resolveArticleImageUrl(src || "", sourceUrl);
                                                if (!resolvedSrc) return;
                                                openPreview({
                                                    kind: "image",
                                                    title: "Image preview",
                                                    imageSrc: resolvedSrc,
                                                    imageAlt: alt || "Article image",
                                                    sourceHref: resolvedSrc,
                                                });
                                            }}
                                        />
                                    ),
                                    a: ({ href, children }) => (
                                        <a
                                            href={href}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="article-reader-link"
                                        >
                                            {children}
                                        </a>
                                    ),
                                }}
                            >
                                {rawContent || ""}
                            </Markdown>
                        ) : hasStructuredBlocks ? (
                            <>
                                {structuredSections.contentBlocks.map((block, index) => {
                                if (block.type === "image" && block.imageUrl) {
                                    return (
                                        <ArticleImageFigure
                                            key={block.id}
                                            imageSrc={block.imageUrl || ""}
                                            altText={block.caption || `Article image ${index + 1}`}
                                            caption={block.caption}
                                            onOpenPreview={() => {
                                                openPreview({
                                                    kind: "image",
                                                    title: "Image preview",
                                                    imageSrc: block.imageUrl || "",
                                                    imageAlt: block.caption || `Article image ${index + 1}`,
                                                    caption: block.caption,
                                                    sourceHref: block.imageUrl || "",
                                                });
                                            }}
                                        />
                                    );
                                }

                                if (block.type === "h1") {
                                    const headingAnchorId = getArticleHeadingAnchorId(block.id);
                                    return (
                                        <h2
                                            key={block.id}
                                            id={headingAnchorId}
                                            data-article-heading-anchor={headingAnchorId}
                                            className="article-reader-heading-1 text-foreground"
                                        >
                                            {block.inlineRuns && block.inlineRuns.length > 0 ? (
                                                <InlineRichRuns
                                                    runs={block.inlineRuns}
                                                    onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                                    onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                                    activeReferenceAnchorId={activeReferenceAnchorId}
                                                />
                                            ) : block.inlineMarkdown ? (
                                                <InlineRichText
                                                    markdown={block.inlineMarkdown}
                                                    onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                                    onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                                    activeReferenceAnchorId={activeReferenceAnchorId}
                                                />
                                            ) : block.text}
                                        </h2>
                                    );
                                }

                                if (block.type === "h2") {
                                    const headingAnchorId = getArticleHeadingAnchorId(block.id);
                                    return (
                                        <h3
                                            key={block.id}
                                            id={headingAnchorId}
                                            data-article-heading-anchor={headingAnchorId}
                                            className="article-reader-heading-2 text-foreground"
                                        >
                                            {block.inlineRuns && block.inlineRuns.length > 0 ? (
                                                <InlineRichRuns
                                                    runs={block.inlineRuns}
                                                    onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                                    onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                                    activeReferenceAnchorId={activeReferenceAnchorId}
                                                />
                                            ) : block.inlineMarkdown ? (
                                                <InlineRichText
                                                    markdown={block.inlineMarkdown}
                                                    onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                                    onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                                    activeReferenceAnchorId={activeReferenceAnchorId}
                                                />
                                            ) : block.text}
                                        </h3>
                                    );
                                }

                                if (block.type === "h3") {
                                    const headingAnchorId = getArticleHeadingAnchorId(block.id);
                                    return (
                                        <h4
                                            key={block.id}
                                            id={headingAnchorId}
                                            data-article-heading-anchor={headingAnchorId}
                                            className="article-reader-heading-3 text-foreground/95"
                                        >
                                            {block.inlineRuns && block.inlineRuns.length > 0 ? (
                                                <InlineRichRuns
                                                    runs={block.inlineRuns}
                                                    onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                                    onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                                    activeReferenceAnchorId={activeReferenceAnchorId}
                                                />
                                            ) : block.inlineMarkdown ? (
                                                <InlineRichText
                                                    markdown={block.inlineMarkdown}
                                                    onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                                    onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                                    activeReferenceAnchorId={activeReferenceAnchorId}
                                                />
                                            ) : block.text}
                                        </h4>
                                    );
                                }

                                if (block.type === "blockquote") {
                                    return (
                                        <blockquote
                                            key={block.id}
                                            className="article-content-block article-reader-quote"
                                        >
                                            {block.inlineRuns && block.inlineRuns.length > 0 ? (
                                                <InlineRichRuns
                                                    runs={block.inlineRuns}
                                                    onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                                    onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                                    activeReferenceAnchorId={activeReferenceAnchorId}
                                                />
                                            ) : block.inlineMarkdown ? (
                                                <InlineRichText
                                                    markdown={block.inlineMarkdown}
                                                    onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                                    onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                                    activeReferenceAnchorId={activeReferenceAnchorId}
                                                />
                                            ) : block.text}
                                        </blockquote>
                                    );
                                }

                                if (block.type === "equation" && block.equationTex) {
                                    return (
                                        <EquationBlockPanel
                                            key={block.id}
                                            block={block}
                                            onOpenPreview={() => {
                                                openPreview({
                                                    kind: "equation",
                                                    title: "Equation preview",
                                                    equationTex: block.equationTex || "",
                                                    equationNumber: block.equationNumber,
                                                });
                                            }}
                                        />
                                    );
                                }

                                if (block.type === "list" && block.items && block.items.length > 0) {
                                    const ListTag = (block.ordered ? "ol" : "ul") as "ol" | "ul";
                                    return (
                                        <ListTag
                                            key={block.id}
                                            className={`article-content-block article-reader-list ${block.ordered ? "list-decimal" : "list-disc"}`}
                                            data-testid="article-list-block"
                                        >
                                            {block.items.map((item, itemIndex) => (
                                                <li key={`${block.id}-item-${itemIndex}`}>{item}</li>
                                            ))}
                                        </ListTag>
                                    );
                                }

                                if (block.type === "code" && block.text) {
                                    return (
                                        <pre
                                            key={block.id}
                                            className="article-content-block article-reader-wide article-reader-code-block overflow-x-auto px-5 py-4 text-[13px] leading-6 text-foreground/90"
                                            data-testid="article-code-block"
                                        >
                                            <code>{block.text}</code>
                                        </pre>
                                    );
                                }

                                if (block.type === "table") {
                                    return (
                                        <StructuredTableFigure
                                            key={block.id}
                                            block={block}
                                            onOpenPreview={() => {
                                                openPreview({
                                                    kind: "table",
                                                    title: "Table preview",
                                                    tableBlock: block,
                                                    caption: block.caption,
                                                });
                                            }}
                                            onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                            onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                            activeReferenceAnchorId={activeReferenceAnchorId}
                                        />
                                    );
                                }

                                return (
                                    <p key={block.id} className="article-reader-paragraph">
                                        {block.inlineRuns && block.inlineRuns.length > 0 ? (
                                            <InlineRichRuns
                                                runs={block.inlineRuns}
                                                onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                                onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                                activeReferenceAnchorId={activeReferenceAnchorId}
                                            />
                                        ) : block.inlineMarkdown ? (
                                            <InlineRichText
                                                markdown={block.inlineMarkdown}
                                                onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                                onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                                activeReferenceAnchorId={activeReferenceAnchorId}
                                            />
                                        ) : block.text}
                                    </p>
                                );
                                })}

                                {hasReferenceBlocks && (
                                    <section
                                        className="article-reference-section"
                                        data-testid="article-reference-section"
                                    >
                                        <div className="article-reference-header">
                                            <div className="min-w-0 space-y-2">
                                                <h3 className="article-reference-title">
                                                    {structuredSections.referenceTitle}
                                                </h3>
                                                <p className="article-reference-meta">
                                                    {referencesExpanded
                                                        ? `Showing all ${structuredSections.referenceBlocks.length} references`
                                                        : `Showing ${Math.min(REFERENCE_PREVIEW_COUNT, structuredSections.referenceBlocks.length)} of ${structuredSections.referenceBlocks.length} references`}
                                                </p>
                                            </div>
                                            <div className="flex flex-wrap items-center justify-end gap-2">
                                                {referenceNavigation?.canReturn && (
                                                    <button
                                                        type="button"
                                                        className="article-reference-return"
                                                        data-testid="article-reference-return"
                                                        onClick={handleReturnFromReference}
                                                    >
                                                        Back to Reading Position
                                                    </button>
                                                )}
                                                {structuredSections.referenceBlocks.length > REFERENCE_PREVIEW_COUNT && (
                                                    <button
                                                        type="button"
                                                        className="article-reference-toggle"
                                                        data-testid="article-reference-toggle"
                                                        aria-expanded={referencesExpanded}
                                                        onClick={() => setReferencesExpanded((current) => !current)}
                                                    >
                                                        {referencesExpanded
                                                            ? "Collapse"
                                                            : `Expand all (${structuredSections.referenceBlocks.length})`}
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        <div
                                            className={`article-reference-grid ${!referencesExpanded && structuredSections.referenceBlocks.length > REFERENCE_PREVIEW_COUNT ? "article-reference-grid-collapsed" : ""}`}
                                        >
                                            {structuredSections.referenceBlocks.map((referenceBlock) => (
                                                <div
                                                    key={referenceBlock.id}
                                                    id={referenceBlock.anchorId}
                                                    className={`article-reference-card ${referenceBlock.anchorId && activeReferenceAnchorId === referenceBlock.anchorId ? "article-reference-card-linked" : ""} ${referenceNavigation?.anchorId === referenceBlock.anchorId ? "article-reference-card-jump-target" : ""}`.trim()}
                                                    data-testid="article-reference-block"
                                                    data-article-reference-anchor={referenceBlock.anchorId || undefined}
                                                    onMouseEnter={() => {
                                                        if (referenceBlock.anchorId) {
                                                            setHoveredReferenceAnchorId(referenceBlock.anchorId);
                                                        }
                                                    }}
                                                    onMouseLeave={() => {
                                                        if (referenceBlock.anchorId) {
                                                            setHoveredReferenceAnchorId((current) => (
                                                                current === referenceBlock.anchorId ? null : current
                                                            ));
                                                        }
                                                    }}
                                                    onFocusCapture={() => {
                                                        if (referenceBlock.anchorId) {
                                                            setHoveredReferenceAnchorId(referenceBlock.anchorId);
                                                        }
                                                    }}
                                                    onBlurCapture={(event) => {
                                                        if (!referenceBlock.anchorId) {
                                                            return;
                                                        }
                                                        const relatedTarget = event.relatedTarget as Node | null;
                                                        if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
                                                            return;
                                                        }
                                                        setHoveredReferenceAnchorId((current) => (
                                                            current === referenceBlock.anchorId ? null : current
                                                        ));
                                                    }}
                                                >
                                                    {referenceNavigation?.anchorId === referenceBlock.anchorId && (
                                                        <div className="article-reference-target-meta">
                                                            <span className="article-reference-target-badge">
                                                                Linked Reference
                                                            </span>
                                                        </div>
                                                    )}
                                                    {referenceBlock.links && referenceBlock.links.length > 0 ? (
                                                        <a
                                                            href={referenceBlock.links[0].href}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="article-reference-primary"
                                                        >
                                                            <p className="article-reference-text">{referenceBlock.text}</p>
                                                        </a>
                                                    ) : (
                                                        <p className="article-reference-text">{referenceBlock.text}</p>
                                                    )}
                                                    {referenceBlock.links && referenceBlock.links.length > 0 && (
                                                        <div className="article-reference-links">
                                                            {referenceBlock.links.map((link, linkIndex) => (
                                                                <a
                                                                    key={`${referenceBlock.id}-link-${linkIndex}`}
                                                                    href={link.href}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="article-reference-link"
                                                                    data-testid="article-reference-link"
                                                                >
                                                                    {link.label}
                                                                </a>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>

                                        {!referencesExpanded && structuredSections.referenceBlocks.length > REFERENCE_PREVIEW_COUNT && (
                                            <div className="article-reference-collapsed-footer">
                                                <button
                                                    type="button"
                                                    className="article-reference-inline-button"
                                                    onClick={() => setReferencesExpanded(true)}
                                                >
                                                    View remaining {Math.max(0, structuredSections.referenceBlocks.length - REFERENCE_PREVIEW_COUNT)} references
                                                </button>
                                            </div>
                                        )}
                                    </section>
                                )}
                            </>
                        ) : (
                            paragraphs.map((paragraph, idx) => (
                                <p key={`${idx}-${paragraph.slice(0, 24)}`} className="article-reader-paragraph">
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
            </div>

            {activePreview && (
                <div
                    className={`fixed inset-0 z-[70] flex items-center justify-center p-2 backdrop-blur-sm sm:p-3 ${activePreview.kind === "equation" ? "bg-slate-950/55" : "bg-slate-950/82"}`}
                    data-testid={activePreview.kind === "image" ? "article-image-lightbox" : "article-preview-lightbox"}
                    onClick={closePreview}
                >
                    <div
                        className={`article-preview-panel flex h-[calc(100vh-1rem)] w-[calc(100vw-1rem)] max-w-none flex-col overflow-hidden rounded-[1.25rem] border shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:h-[calc(100vh-1.5rem)] sm:w-[calc(100vw-1.5rem)] ${activePreview.kind === "equation"
                            ? "border-slate-200/85 bg-white/96 text-slate-900 shadow-[0_24px_80px_rgba(15,23,42,0.16)]"
                            : "border-white/12 bg-slate-950/94 text-white"}`}
                        data-testid="article-preview-panel"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className={`flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4 ${activePreview.kind === "equation" ? "border-slate-200/90" : "border-white/10"}`}>
                            <div className="min-w-0 space-y-1">
                                <p className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${activePreview.kind === "equation" ? "text-slate-500" : "text-white/55"}`}>{activePreview.title}</p>
                                <p className={`text-sm leading-6 ${activePreview.kind === "equation" ? "text-slate-700" : "text-white/80"}`}>
                                    {activePreview.kind === "image"
                                        ? (activePreview.caption || activePreview.imageAlt)
                                        : activePreview.kind === "table"
                                            ? (activePreview.caption || "Click cells or scroll horizontally after zooming.")
                                            : (activePreview.equationNumber ? `Equation ${activePreview.equationNumber}` : "Use the mouse wheel to zoom in and out.")}
                                </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    className={`article-lightbox-action ${activePreview.kind === "equation" ? "article-lightbox-action-light" : ""}`.trim()}
                                    onClick={() => adjustPreviewZoom(-0.18)}
                                >
                                    -
                                </button>
                                <button
                                    type="button"
                                    className={`article-lightbox-action ${activePreview.kind === "equation" ? "article-lightbox-action-light" : ""}`.trim()}
                                    data-testid="article-preview-zoom-value"
                                    onClick={() => setPreviewZoom(1)}
                                >
                                    {Math.round(previewZoom * 100)}%
                                </button>
                                <button
                                    type="button"
                                    className={`article-lightbox-action ${activePreview.kind === "equation" ? "article-lightbox-action-light" : ""}`.trim()}
                                    onClick={() => adjustPreviewZoom(0.18)}
                                >
                                    +
                                </button>
                                {activePreview.kind !== "image" && (
                                    <button
                                        type="button"
                                        className={`article-lightbox-action ${activePreview.kind === "equation" ? "article-lightbox-action-light" : ""}`.trim()}
                                        data-testid="article-preview-select-text"
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={selectPreviewText}
                                    >
                                        Select text
                                    </button>
                                )}
                                {activePreview.kind === "image" && activePreview.sourceHref && (
                                    <a
                                        href={activePreview.sourceHref}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className={`article-lightbox-action ${activePreview.kind === "equation" ? "article-lightbox-action-light" : ""}`.trim()}
                                        data-testid="article-image-open-original"
                                    >
                                        Open original
                                    </a>
                                )}
                                <button
                                    type="button"
                                    className={`article-lightbox-action ${activePreview.kind === "equation" ? "article-lightbox-action-light" : ""}`.trim()}
                                    data-testid="article-image-lightbox-close"
                                    onClick={closePreview}
                                >
                                    Close
                                </button>
                            </div>
                        </div>
                        <div
                            className={`article-preview-scroll ${activePreview.kind === "equation" ? "article-preview-scroll-equation" : ""}`.trim()}
                            data-testid="article-preview-scroll"
                            onWheel={handlePreviewWheel}
                        >
                            <div className={`article-preview-scroll-body ${activePreview.kind === "equation" ? "article-preview-scroll-body-compact" : ""}`.trim()}>
                                <div className={`article-preview-content-layout ${previewSelectableText ? "article-preview-content-layout-with-text" : ""}`.trim()}>
                                    <div className="article-preview-visual-slot">
                                        {activePreview.kind === "image" ? (
                                            <div
                                                className="article-preview-scale-frame article-preview-scale-frame-image"
                                                data-testid="article-preview-scale-frame"
                                                ref={previewContentRef}
                                                style={{ width: `${Math.max(52, Math.round(previewZoom * 100))}%` }}
                                            >
                                                <ArticleImageFigure
                                                    imageSrc={activePreview.imageSrc}
                                                    altText={activePreview.imageAlt}
                                                    previewMode
                                                    imageTestId="article-image-lightbox-image"
                                                />
                                            </div>
                                        ) : activePreview.kind === "table" ? (
                                            <div
                                                className="article-preview-scale-frame article-preview-scale-frame-table"
                                                data-testid="article-preview-scale-frame"
                                                ref={previewContentRef}
                                                style={{ width: `${Math.max(72, Math.round(previewZoom * 100))}%` }}
                                            >
                                                <StructuredTableFigure
                                                    block={activePreview.tableBlock}
                                                    previewMode
                                                    onInternalReferenceNavigate={handleInternalReferenceNavigate}
                                                    onInternalReferenceHoverChange={setHoveredReferenceAnchorId}
                                                    activeReferenceAnchorId={activeReferenceAnchorId}
                                                />
                                            </div>
                                        ) : (
                                            <div
                                                className="article-preview-scale-frame article-preview-scale-frame-equation"
                                                data-testid="article-preview-scale-frame"
                                                ref={previewContentRef}
                                                style={{ fontSize: `${previewZoom}em` }}
                                            >
                                                <EquationBlockPanel
                                                    block={{
                                                        id: "article-preview-equation",
                                                        equationTex: activePreview.equationTex,
                                                        equationNumber: activePreview.equationNumber,
                                                    }}
                                                    previewMode
                                                />
                                            </div>
                                        )}
                                    </div>
                                    {previewSelectableText && activePreview.kind !== "image" && (
                                        <div className="article-preview-text-pane" data-testid="article-preview-text-pane">
                                            <p className="article-preview-text-label">Selectable text</p>
                                            <textarea
                                                ref={previewTextAreaRef}
                                                readOnly
                                                className="article-preview-textarea"
                                                data-testid="article-preview-textarea"
                                                value={previewSelectableText}
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

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
