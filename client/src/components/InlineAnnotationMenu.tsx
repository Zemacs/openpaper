import {
    PaperHighlight,
} from '@/lib/schema';

import { useCallback, useEffect, useLayoutEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui/button";
import { CommandShortcut, localizeCommandToOS } from "./ui/command";
import SelectionTranslationCard from "./SelectionTranslationCard";
import { useSelectionTranslation } from "./hooks/useSelectionTranslation";
import { Bookmark, Copy, Highlighter, Languages, MessageCircle, Minus, X } from "lucide-react";

interface InlineAnnotationMenuProps {
    paperId?: string;
    selectedPageNumber?: number | null;
    selectedContextBefore?: string | null;
    selectedContextAfter?: string | null;
    selectedText: string;
    tooltipPosition: { x: number; y: number } | null;
    setSelectedText: (text: string) => void;
    setTooltipPosition: (position: { x: number; y: number } | null) => void;
    setIsAnnotating: (isAnnotating: boolean) => void;
    highlights: Array<PaperHighlight>;
    setHighlights: (highlights: Array<PaperHighlight>) => void;
    isSelectionInProgress?: boolean;
    isHighlightInteraction: boolean;
    activeHighlight: PaperHighlight | null;
    addHighlight: (selectedText: string, doAnnotate?: boolean) => void;
    removeHighlight: (highlight: PaperHighlight) => void;
    setUserMessageReferences: React.Dispatch<React.SetStateAction<string[]>>;
}

const MENU_WIDTH = 280;
const MENU_OFFSET = 20;
const MENU_VIEWPORT_PADDING = 12;
const FALLBACK_MENU_HEIGHT = 460;
const MIN_VISIBLE_MENU_HEIGHT = 120;
const MENU_ANCHOR_RESET_THRESHOLD = 12;

export default function InlineAnnotationMenu(props: InlineAnnotationMenuProps) {
    const {
        paperId,
        selectedPageNumber,
        selectedContextBefore,
        selectedContextAfter,
        selectedText,
        tooltipPosition,
        setSelectedText,
        setTooltipPosition,
        setIsAnnotating,
        isSelectionInProgress = false,
        isHighlightInteraction,
        activeHighlight,
        addHighlight,
        removeHighlight,
        setUserMessageReferences,
    } = props;

    const menuRef = useRef<HTMLDivElement>(null);
    const lastAutoTranslateKeyRef = useRef<string>("");
    const lastAnchorRef = useRef<{ x: number; y: number } | null>(null);
    const verticalPlacementRef = useRef<"above" | "below" | null>(null);
    const isMenuOpen = Boolean(tooltipPosition);
    const [menuLayout, setMenuLayout] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
    const [isMounted, setIsMounted] = useState(false);
    const {
        translation,
        isTranslating,
        translationError,
        translateSelection,
        retryLast,
        clear: clearTranslation,
    } = useSelectionTranslation(paperId);

    const calculateMenuLayout = useCallback(() => {
        if (!tooltipPosition) {
            setMenuLayout(null);
            lastAnchorRef.current = null;
            verticalPlacementRef.current = null;
            return;
        }

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const maxAvailableWidth = Math.max(220, viewportWidth - MENU_VIEWPORT_PADDING * 2);
        const isCompactViewport = viewportWidth < 900;
        const baseWidth = isCompactViewport
            ? Math.round(viewportWidth * 0.92)
            : Math.round(viewportWidth * 0.42);
        const textBoost = Math.min(120, Math.max(0, selectedText.length - 32) * 1.1);
        const targetWidth = Math.min(680, Math.max(360, baseWidth + textBoost));
        const width = Math.min(maxAvailableWidth, targetWidth);

        const measuredHeight = menuRef.current?.offsetHeight;
        const menuHeight = measuredHeight && measuredHeight > 0
            ? measuredHeight
            : FALLBACK_MENU_HEIGHT;

        const anchorX = tooltipPosition.x;
        const anchorY = tooltipPosition.y;

        const previousAnchor = lastAnchorRef.current;
        const anchorMoved = !previousAnchor
            || Math.abs(previousAnchor.x - anchorX) > MENU_ANCHOR_RESET_THRESHOLD
            || Math.abs(previousAnchor.y - anchorY) > MENU_ANCHOR_RESET_THRESHOLD;
        if (anchorMoved) {
            lastAnchorRef.current = { x: anchorX, y: anchorY };
            verticalPlacementRef.current = null;
        }

        let left = anchorX - width / 2;
        left = Math.max(MENU_VIEWPORT_PADDING, Math.min(left, viewportWidth - width - MENU_VIEWPORT_PADDING));

        const preferredBelow = anchorY + MENU_OFFSET;
        const spaceBelow = viewportHeight - preferredBelow - MENU_VIEWPORT_PADDING;
        const spaceAbove = anchorY - MENU_OFFSET - MENU_VIEWPORT_PADDING;
        const fitsBelow = menuHeight <= spaceBelow;
        const fitsAbove = menuHeight <= spaceAbove;

        if (!verticalPlacementRef.current) {
            if (fitsBelow) {
                verticalPlacementRef.current = "below";
            } else if (fitsAbove) {
                verticalPlacementRef.current = "above";
            } else {
                verticalPlacementRef.current = spaceBelow >= spaceAbove ? "below" : "above";
            }
        }

        const preferredPlacement = verticalPlacementRef.current || "below";
        const maxHeight = Math.max(
            MIN_VISIBLE_MENU_HEIGHT,
            preferredPlacement === "below" ? spaceBelow : spaceAbove,
        );

        let top: number;
        if (preferredPlacement === "below") {
            top = preferredBelow;
            const minBottomVisibleTop = viewportHeight - MENU_VIEWPORT_PADDING - MIN_VISIBLE_MENU_HEIGHT;
            top = Math.max(MENU_VIEWPORT_PADDING, Math.min(top, minBottomVisibleTop));
        } else {
            const effectiveHeight = Math.min(menuHeight, maxHeight);
            top = anchorY - MENU_OFFSET - effectiveHeight;
            top = Math.max(MENU_VIEWPORT_PADDING, top);
        }

        setMenuLayout((prev) => {
            if (
                prev &&
                Math.abs(prev.left - left) < 1 &&
                Math.abs(prev.top - top) < 1 &&
                Math.abs(prev.width - width) < 1 &&
                Math.abs(prev.maxHeight - maxHeight) < 1
            ) {
                return prev;
            }
            return { left, top, width, maxHeight };
        });
    }, [selectedText, tooltipPosition]);

    useEffect(() => {
        setIsMounted(true);
    }, []);

    useLayoutEffect(() => {
        if (!isMounted) return;
        calculateMenuLayout();
        const raf = requestAnimationFrame(() => {
            calculateMenuLayout();
        });
        return () => cancelAnimationFrame(raf);
    }, [
        isMounted,
        tooltipPosition,
        selectedText,
        translation,
        translationError,
        isTranslating,
        calculateMenuLayout,
    ]);

    useEffect(() => {
        if (!isMounted) return;

        const onWindowChange = () => {
            calculateMenuLayout();
        };

        window.addEventListener("resize", onWindowChange);
        window.addEventListener("orientationchange", onWindowChange);
        return () => {
            window.removeEventListener("resize", onWindowChange);
            window.removeEventListener("orientationchange", onWindowChange);
        };
    }, [isMounted, calculateMenuLayout]);

    useEffect(() => {
        if (!isMounted || !tooltipPosition) return;
        const node = menuRef.current;
        if (!node) return;

        const observer = new ResizeObserver(() => {
            calculateMenuLayout();
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [isMounted, tooltipPosition, calculateMenuLayout]);

    useEffect(() => {
        if (isSelectionInProgress) {
            lastAutoTranslateKeyRef.current = "";
            clearTranslation();
            return;
        }

        if (!paperId || !selectedText.trim() || !isMenuOpen) {
            lastAutoTranslateKeyRef.current = "";
            clearTranslation();
            return;
        }

        const requestKey = [
            paperId,
            selectedText.replace(/\s+/g, " ").trim().toLowerCase(),
            selectedPageNumber || "",
            (selectedContextBefore || "").replace(/\s+/g, " ").trim().toLowerCase(),
            (selectedContextAfter || "").replace(/\s+/g, " ").trim().toLowerCase(),
        ].join("|");
        if (requestKey === lastAutoTranslateKeyRef.current) {
            return;
        }

        const timerId = setTimeout(() => {
            lastAutoTranslateKeyRef.current = requestKey;
            void translateSelection({
                selectedText,
                pageNumber: selectedPageNumber || undefined,
                selectionTypeHint: "auto",
                contextBefore: selectedContextBefore || undefined,
                contextAfter: selectedContextAfter || undefined,
            });
        }, 250);

        return () => clearTimeout(timerId);
    }, [
        paperId,
        selectedText,
        isMenuOpen,
        isSelectionInProgress,
        selectedPageNumber,
        selectedContextBefore,
        selectedContextAfter,
        translateSelection,
        clearTranslation,
    ]);

    useEffect(() => {
        const handleMouseDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setSelectedText("");
                setTooltipPosition(null);
                setIsAnnotating(false);
            } else if (e.key === "c" && (e.ctrlKey || e.metaKey)) {
                navigator.clipboard.writeText(selectedText);
            } else if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
                setUserMessageReferences((prev: string[]) => {
                    const newReferences = [...prev, selectedText];
                    return Array.from(new Set(newReferences)); // Remove duplicates
                });
            } else if (e.key === "t" && (e.ctrlKey || e.metaKey) && paperId) {
                void translateSelection({
                    selectedText,
                    pageNumber: selectedPageNumber || undefined,
                    selectionTypeHint: "auto",
                    contextBefore: selectedContextBefore || undefined,
                    contextAfter: selectedContextAfter || undefined,
                    force: true,
                });
            } else if (e.key === "h" && (e.ctrlKey || e.metaKey)) {
                addHighlight(selectedText);
                e.stopPropagation();
            } else if (e.key === "d" && (e.ctrlKey || e.metaKey) && isHighlightInteraction && activeHighlight) {
                removeHighlight(activeHighlight);
                setSelectedText("");
                setTooltipPosition(null);
                setIsAnnotating(false);
            } else if (e.key === "e" && (e.ctrlKey || e.metaKey)) {
                setIsAnnotating(true);
                setTooltipPosition(null);
                setSelectedText("");
            } else {
                return;
            }

            e.preventDefault();
            e.stopPropagation();
        }

        window.addEventListener("keydown", handleMouseDown);
        return () => window.removeEventListener("keydown", handleMouseDown);
    }, [
        selectedText,
        setSelectedText,
        setTooltipPosition,
        setIsAnnotating,
        setUserMessageReferences,
        addHighlight,
        isHighlightInteraction,
        activeHighlight,
        removeHighlight,
        paperId,
        selectedPageNumber,
        selectedContextBefore,
        selectedContextAfter,
        translateSelection,
    ]);

    if (!tooltipPosition || !menuLayout || !isMounted) return null;

    const menuNode = (
        <div
            ref={menuRef}
            data-testid="inline-annotation-menu"
            className="fixed z-[2147483000] bg-background shadow-lg rounded-lg p-3 border border-border overflow-y-auto"
            style={{
                left: `${menuLayout.left}px`,
                top: `${menuLayout.top}px`,
                width: `${menuLayout.width}px`,
                minWidth: `${Math.min(MENU_WIDTH, menuLayout.width)}px`,
                maxHeight: `${menuLayout.maxHeight}px`,
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="flex flex-col gap-1.5">
                {/* Copy Button */}
                <Button
                    variant="ghost"
                    className="w-full flex items-center justify-between text-sm font-normal h-9 px-2"
                    onClick={() => {
                        navigator.clipboard.writeText(selectedText);
                        setSelectedText("");
                        setTooltipPosition(null);
                        setIsAnnotating(false);
                    }}
                >
                    <div className="flex items-center gap-2">
                        <Copy size={14} />
                        Copy
                    </div>
                    <CommandShortcut className="text-muted-foreground">
                        {localizeCommandToOS('C')}
                    </CommandShortcut>
                </Button>

                {/* Highlight Button */}
                {
                    !isHighlightInteraction && (
                        <Button
                            variant="ghost"
                            className="w-full flex items-center justify-between text-sm font-normal h-9 px-2"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => {
                                e.stopPropagation();
                                addHighlight(selectedText, false);
                            }}
                        >
                            <div className="flex items-center gap-2">
                                <Bookmark size={14} />
                                Save
                            </div>
                            <CommandShortcut className="text-muted-foreground">
                                {localizeCommandToOS('H')}
                            </CommandShortcut>
                        </Button>
                    )
                }

                {/* Annotate Button */}
                {
                    <Button
                        variant="ghost"
                        className="w-full flex items-center justify-between text-sm font-normal h-9 px-2"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                            e.stopPropagation();
                            setIsAnnotating(true);
                            setTooltipPosition(null);
                            setSelectedText("");
                            if (!isHighlightInteraction) {
                                addHighlight(selectedText, true);
                            }
                        }}
                    >
                        <div className="flex items-center gap-2">
                            <Highlighter size={14} />
                            Annotate
                        </div>
                        <CommandShortcut className="text-muted-foreground">
                            {localizeCommandToOS('E')}
                        </CommandShortcut>
                    </Button>
                }

                {/* Add to Chat Button */}
                <Button
                    variant="ghost"
                    className="w-full flex items-center justify-between text-sm font-normal h-9 px-2"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                        setUserMessageReferences(prev => Array.from(new Set([...prev, selectedText])));
                        setSelectedText("");
                        setTooltipPosition(null);
                        setIsAnnotating(false);
                        e.stopPropagation();
                    }}
                >
                    <div className="flex items-center gap-2">
                        <MessageCircle size={14} />
                        Ask
                    </div>
                    <CommandShortcut className="text-muted-foreground">
                        {localizeCommandToOS('A')}
                    </CommandShortcut>
                </Button>

                {/* Translate Button */}
                {paperId && (
                    <Button
                        data-testid="inline-translate-button"
                        variant="ghost"
                        className="w-full flex items-center justify-between text-sm font-normal h-9 px-2"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                            e.stopPropagation();
                            void translateSelection({
                                selectedText,
                                pageNumber: selectedPageNumber || undefined,
                                selectionTypeHint: "auto",
                                contextBefore: selectedContextBefore || undefined,
                                contextAfter: selectedContextAfter || undefined,
                                force: true,
                            });
                        }}
                    >
                        <div className="flex items-center gap-2">
                            <Languages size={14} />
                            Translate
                        </div>
                        <CommandShortcut className="text-muted-foreground">
                            {localizeCommandToOS('T')}
                        </CommandShortcut>
                    </Button>
                )}


                {/* Remove Highlight Button - Only show when interacting with highlight */}
                {isHighlightInteraction && activeHighlight && (
                    <Button
                        variant="ghost"
                        className="w-full flex items-center justify-between text-sm font-normal h-9 px-2 text-destructive"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (activeHighlight) {
                                removeHighlight(activeHighlight);
                                setSelectedText("");
                                setTooltipPosition(null);
                                setIsAnnotating(false);
                            }
                        }}
                    >
                        <div className="flex items-center gap-2">
                            <Minus size={14} />
                            Delete
                        </div>
                        <CommandShortcut className="text-muted-foreground">
                            {localizeCommandToOS('D')}
                        </CommandShortcut>
                    </Button>
                )}

                {/* Close Button */}
                <Button
                    variant="ghost"
                    className="w-full flex items-center justify-between text-sm font-normal h-9 px-2"
                    onClick={() => {
                        setSelectedText("");
                        setTooltipPosition(null);
                        setIsAnnotating(false);
                    }}
                >
                    <div className="flex items-center gap-2">
                        <X size={14} />
                        Close
                    </div>
                    <CommandShortcut className="text-muted-foreground">
                        Esc
                    </CommandShortcut>
                </Button>

                <SelectionTranslationCard
                    translation={translation}
                    isLoading={isTranslating}
                    error={translationError}
                    onRetry={() => {
                        void retryLast();
                    }}
                />
            </div>
        </div>
    );

    return createPortal(menuNode, document.body);
}
