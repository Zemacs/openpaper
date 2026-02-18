"use client";

import dynamic from "next/dynamic";
import type { PdfHighlighterViewerProps } from "./PdfHighlighterViewerImpl";

// SSR-safe re-exports — import directly from types module to avoid loading
// pdf-viewer/index.ts (which re-exports browser-only modules).
export type { ExtendedHighlight } from "./pdf-viewer/types";
export {
  paperHighlightToExtended,
  extendedToPaperHighlight,
} from "./pdf-viewer/types";

// RenderedHighlightPosition is a plain interface defined in the impl file.
// Re-declare it here so consumers keep the same import path without pulling in
// the heavy impl module (which imports pdfjs-dist and crashes SSR).
export interface RenderedHighlightPosition {
  left: number;
  top: number;
  width: number;
  height: number;
  page: number;
}

// Load the actual component only on the client — react-pdf-highlighter-extended
// imports pdfjs-dist/web/pdf_viewer.mjs at module evaluation time, which
// accesses window/document and crashes Next.js SSR.
export const PdfHighlighterViewer = dynamic<PdfHighlighterViewerProps>(
  () =>
    import("./PdfHighlighterViewerImpl").then(
      (mod) => mod.PdfHighlighterViewer,
    ),
  { ssr: false },
);
