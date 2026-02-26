"use client";

import { useMemo, useState } from "react";

import { SidePanelContent } from "@/components/SidePanelContent";
import { PaperData, PaperHighlight, PaperHighlightAnnotation } from "@/lib/schema";
import { AuthProvider } from "@/lib/auth";

const HARNESS_PAPER_ID = "00000000-0000-0000-0000-00000000c0de";

const HARNESS_PAPER: PaperData = {
    filename: "harness.pdf",
    file_url: "",
    authors: ["Harness Author"],
    title: "Chat E2E Harness Paper",
    abstract: "Harness paper abstract.",
    publish_date: "2026-01-01",
    summary: "",
    summary_citations: [],
    institutions: ["Harness Lab"],
    keywords: ["harness"],
    starter_questions: [],
    is_public: false,
    share_id: "",
    status: "reading",
};

export default function ChatE2EPage() {
    const harnessEnabled = process.env.NEXT_PUBLIC_ENABLE_E2E_HARNESS === "true";

    const [rightSideFunction, setRightSideFunction] = useState("Chat");
    const [annotations, setAnnotations] = useState<PaperHighlightAnnotation[]>([]);
    const [activeHighlight, setActiveHighlight] = useState<PaperHighlight | null>(null);
    const [userMessageReferences, setUserMessageReferences] = useState<string[]>([]);
    const [explicitSearchTerm, setExplicitSearchTerm] = useState("");

    const paperData = useMemo(() => HARNESS_PAPER, []);
    const highlights: PaperHighlight[] = [];

    if (!harnessEnabled) {
        return (
            <main className="mx-auto max-w-2xl p-8">
                <p className="text-sm text-muted-foreground" data-testid="chat-e2e-disabled">
                    Chat E2E harness is disabled.
                </p>
            </main>
        );
    }

    return (
        <main className="h-[calc(100vh-64px)] p-4" data-testid="chat-e2e-root">
            <div className="mb-2 text-sm text-muted-foreground">
                Explicit search term: <span data-testid="chat-e2e-search-term">{explicitSearchTerm || "none"}</span>
            </div>
            <div className="h-[calc(100%-32px)] overflow-hidden rounded-lg border">
                <AuthProvider>
                    <SidePanelContent
                        rightSideFunction={rightSideFunction}
                        paperData={paperData}
                        annotations={annotations}
                        highlights={highlights}
                        handleHighlightClick={(highlight) => setActiveHighlight(highlight)}
                        addAnnotation={async (highlightId, content) => {
                            const annotation: PaperHighlightAnnotation = {
                                id: `a-${Date.now()}`,
                                highlight_id: highlightId,
                                paper_id: HARNESS_PAPER_ID,
                                content,
                                role: "user",
                                created_at: new Date().toISOString(),
                            };
                            setAnnotations((prev) => [...prev, annotation]);
                            return annotation;
                        }}
                        activeHighlight={activeHighlight}
                        updateAnnotation={(annotationId, text) => {
                            setAnnotations((prev) => prev.map((item) => (
                                item.id === annotationId
                                    ? { ...item, content: text }
                                    : item
                            )));
                        }}
                        removeAnnotation={(annotationId) => {
                            setAnnotations((prev) => prev.filter((item) => item.id !== annotationId));
                        }}
                        isSharing={false}
                        handleShare={() => { }}
                        handleUnshare={() => { }}
                        id={HARNESS_PAPER_ID}
                        matchesCurrentCitation={() => false}
                        handleCitationClickFromSummary={() => { }}
                        setRightSideFunction={setRightSideFunction}
                        setExplicitSearchTerm={setExplicitSearchTerm}
                        handleCitationClick={() => { }}
                        userMessageReferences={userMessageReferences}
                        setUserMessageReferences={setUserMessageReferences}
                        isMobile={false}
                    />
                </AuthProvider>
            </div>
        </main>
    );
}
