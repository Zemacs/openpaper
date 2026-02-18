import {
    type Dispatch,
    type MouseEvent,
    type ReactNode,
    type SetStateAction,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { Bookmark, Copy, Highlighter, Languages, MessageCircle, Minus, X } from "lucide-react";

import { type PaperHighlight } from "@/lib/schema";

import { useSelectionTranslation } from "./hooks/useSelectionTranslation";
import SelectionTranslationCard from "./SelectionTranslationCard";
import { Button } from "./ui/button";
import { CommandShortcut, localizeCommandToOS } from "./ui/command";

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
    isSelectionInProgress?: boolean;
    isHighlightInteraction: boolean;
    activeHighlight: PaperHighlight | null;
    addHighlight: (selectedText: string, doAnnotate?: boolean) => void;
    removeHighlight: (highlight: PaperHighlight) => void;
    setUserMessageReferences: Dispatch<SetStateAction<string[]>>;
}

interface MenuLayout {
    left: number;
    top: number;
    width: number;
    maxHeight: number;
}

interface TranslationPayload {
    selectedText: string;
    pageNumber?: number;
    selectionTypeHint: "auto";
    contextBefore?: string;
    contextAfter?: string;
    force?: boolean;
}

interface MenuItemButtonProps {
    icon: ReactNode;
    label: string;
    shortcut: string;
    onClick: () => void;
    onMouseDown?: (e: MouseEvent<HTMLButtonElement>) => void;
    destructive?: boolean;
    testId?: string;
}

const MENU_MIN_WIDTH = 280;
const MENU_OFFSET = 20;
const MENU_VIEWPORT_PADDING = 12;
const FALLBACK_MENU_HEIGHT = 460;
const MIN_VISIBLE_MENU_HEIGHT = 120;
const MENU_ANCHOR_RESET_THRESHOLD = 12;
const AUTO_TRANSLATE_DELAY_MS = 250;

function normalizeKeyPart(value: string | number | null | undefined): string {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isCommandKey(event: KeyboardEvent, key: string): boolean {
    return event.key.toLowerCase() === key.toLowerCase() && (event.ctrlKey || event.metaKey);
}

function sameLayout(a: MenuLayout | null, b: MenuLayout): boolean {
    if (!a) return false;
    return (
        Math.abs(a.left - b.left) < 1
        && Math.abs(a.top - b.top) < 1
        && Math.abs(a.width - b.width) < 1
        && Math.abs(a.maxHeight - b.maxHeight) < 1
    );
}

function computeMenuWidth(viewportWidth: number, selectedTextLength: number): number {
    const maxAvailableWidth = Math.max(220, viewportWidth - MENU_VIEWPORT_PADDING * 2);
    const isCompactViewport = viewportWidth < 900;
    const baseWidth = isCompactViewport
        ? Math.round(viewportWidth * 0.92)
        : Math.round(viewportWidth * 0.42);
    const textBoost = Math.min(120, Math.max(0, selectedTextLength - 32) * 1.1);
    const targetWidth = Math.min(680, Math.max(360, baseWidth + textBoost));
    return Math.min(maxAvailableWidth, targetWidth);
}

function buildTranslationPayload(
    selectedText: string,
    selectedPageNumber?: number | null,
    selectedContextBefore?: string | null,
    selectedContextAfter?: string | null,
    force?: boolean,
): TranslationPayload {
    return {
        selectedText: selectedText.trim(),
        pageNumber: selectedPageNumber || undefined,
        selectionTypeHint: "auto",
        contextBefore: selectedContextBefore || undefined,
        contextAfter: selectedContextAfter || undefined,
        force,
    };
}

function MenuItemButton({
    icon,
    label,
    shortcut,
    onClick,
    onMouseDown,
    destructive = false,
    testId,
}: MenuItemButtonProps) {
    return (
        <Button
            data-testid={testId}
            variant="ghost"
            className={[
                "h-9 w-full px-2 text-sm font-normal",
                "flex items-center justify-between",
                destructive ? "text-destructive" : "",
            ].join(" ")}
            onMouseDown={onMouseDown}
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
        >
            <div className="flex items-center gap-2">
                {icon}
                {label}
            </div>
            <CommandShortcut className="text-muted-foreground">
                {shortcut}
            </CommandShortcut>
        </Button>
    );
}

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
    const lastAutoTranslateKeyRef = useRef("");
    const lastAnchorRef = useRef<{ x: number; y: number } | null>(null);
    const verticalPlacementRef = useRef<"above" | "below" | null>(null);

    const isMenuOpen = Boolean(tooltipPosition);
    const [isMounted, setIsMounted] = useState(false);
    const [menuLayout, setMenuLayout] = useState<MenuLayout | null>(null);

    const {
        translation,
        isTranslating,
        translationError,
        translateSelection,
        retryLast,
        clear: clearTranslation,
    } = useSelectionTranslation(paperId);

    const closeMenu = useCallback(() => {
        setSelectedText("");
        setTooltipPosition(null);
        setIsAnnotating(false);
    }, [setIsAnnotating, setSelectedText, setTooltipPosition]);

    const requestTranslation = useCallback((force = false) => {
        if (!paperId) return;
        const payload = buildTranslationPayload(
            selectedText,
            selectedPageNumber,
            selectedContextBefore,
            selectedContextAfter,
            force,
        );
        if (!payload.selectedText) return;
        void translateSelection(payload);
    }, [
        paperId,
        selectedText,
        selectedPageNumber,
        selectedContextBefore,
        selectedContextAfter,
        translateSelection,
    ]);

    const calculateMenuLayout = useCallback(() => {
        if (!tooltipPosition) {
            setMenuLayout(null);
            lastAnchorRef.current = null;
            verticalPlacementRef.current = null;
            return;
        }

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const width = computeMenuWidth(viewportWidth, selectedText.length);

        const measuredHeight = menuRef.current?.offsetHeight || FALLBACK_MENU_HEIGHT;
        const menuHeight = measuredHeight > 0 ? measuredHeight : FALLBACK_MENU_HEIGHT;
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

        const left = Math.max(
            MENU_VIEWPORT_PADDING,
            Math.min(
                anchorX - width / 2,
                viewportWidth - width - MENU_VIEWPORT_PADDING,
            ),
        );

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

        const placement = verticalPlacementRef.current || "below";
        const maxHeight = Math.max(
            MIN_VISIBLE_MENU_HEIGHT,
            placement === "below" ? spaceBelow : spaceAbove,
        );

        let top: number;
        if (placement === "below") {
            const minBottomVisibleTop = viewportHeight - MENU_VIEWPORT_PADDING - MIN_VISIBLE_MENU_HEIGHT;
            top = Math.max(MENU_VIEWPORT_PADDING, Math.min(preferredBelow, minBottomVisibleTop));
        } else {
            const effectiveHeight = Math.min(menuHeight, maxHeight);
            top = Math.max(MENU_VIEWPORT_PADDING, anchorY - MENU_OFFSET - effectiveHeight);
        }

        const nextLayout: MenuLayout = { left, top, width, maxHeight };
        setMenuLayout((prev) => (sameLayout(prev, nextLayout) ? prev : nextLayout));
    }, [selectedText.length, tooltipPosition]);

    useEffect(() => {
        setIsMounted(true);
    }, []);

    useLayoutEffect(() => {
        if (!isMounted) return;
        calculateMenuLayout();
        const rafId = requestAnimationFrame(calculateMenuLayout);
        return () => cancelAnimationFrame(rafId);
    }, [
        isMounted,
        calculateMenuLayout,
        tooltipPosition,
        selectedText,
        translation,
        translationError,
        isTranslating,
    ]);

    useEffect(() => {
        if (!isMounted) return;
        const onWindowChange = () => calculateMenuLayout();
        window.addEventListener("resize", onWindowChange);
        window.addEventListener("orientationchange", onWindowChange);
        return () => {
            window.removeEventListener("resize", onWindowChange);
            window.removeEventListener("orientationchange", onWindowChange);
        };
    }, [isMounted, calculateMenuLayout]);

    useEffect(() => {
        if (!isMounted || !tooltipPosition || !menuRef.current) return;
        const observer = new ResizeObserver(calculateMenuLayout);
        observer.observe(menuRef.current);
        return () => observer.disconnect();
    }, [isMounted, tooltipPosition, calculateMenuLayout]);

    useEffect(() => {
        if (isSelectionInProgress) {
            lastAutoTranslateKeyRef.current = "";
            clearTranslation();
            return;
        }

        const trimmedSelectedText = selectedText.trim();
        if (!paperId || !isMenuOpen || !trimmedSelectedText) {
            lastAutoTranslateKeyRef.current = "";
            clearTranslation();
            return;
        }

        const requestKey = [
            normalizeKeyPart(paperId),
            normalizeKeyPart(trimmedSelectedText),
            normalizeKeyPart(selectedPageNumber),
            normalizeKeyPart(selectedContextBefore),
            normalizeKeyPart(selectedContextAfter),
        ].join("|");

        if (requestKey === lastAutoTranslateKeyRef.current) {
            return;
        }

        const timerId = window.setTimeout(() => {
            lastAutoTranslateKeyRef.current = requestKey;
            requestTranslation(false);
        }, AUTO_TRANSLATE_DELAY_MS);

        return () => window.clearTimeout(timerId);
    }, [
        paperId,
        selectedText,
        selectedPageNumber,
        selectedContextBefore,
        selectedContextAfter,
        isMenuOpen,
        isSelectionInProgress,
        requestTranslation,
        clearTranslation,
    ]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                closeMenu();
            } else if (isCommandKey(event, "c")) {
                navigator.clipboard.writeText(selectedText);
            } else if (isCommandKey(event, "a")) {
                setUserMessageReferences((prev) => Array.from(new Set([...prev, selectedText])));
            } else if (paperId && isCommandKey(event, "t")) {
                requestTranslation(true);
            } else if (isCommandKey(event, "h")) {
                addHighlight(selectedText);
            } else if (
                isCommandKey(event, "d")
                && isHighlightInteraction
                && activeHighlight
            ) {
                removeHighlight(activeHighlight);
                closeMenu();
            } else if (isCommandKey(event, "e")) {
                setIsAnnotating(true);
                setTooltipPosition(null);
                setSelectedText("");
            } else {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [
        paperId,
        selectedText,
        isHighlightInteraction,
        activeHighlight,
        closeMenu,
        requestTranslation,
        addHighlight,
        removeHighlight,
        setUserMessageReferences,
        setIsAnnotating,
        setSelectedText,
        setTooltipPosition,
    ]);

    if (!tooltipPosition || !menuLayout || !isMounted) return null;

    const preventMouseDown = (e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
    };

    const menuNode = (
        <div
            ref={menuRef}
            data-testid="inline-annotation-menu"
            className="fixed z-[2147483000] overflow-y-auto rounded-lg border border-border bg-background p-3 shadow-lg"
            style={{
                left: `${menuLayout.left}px`,
                top: `${menuLayout.top}px`,
                width: `${menuLayout.width}px`,
                minWidth: `${Math.min(MENU_MIN_WIDTH, menuLayout.width)}px`,
                maxHeight: `${menuLayout.maxHeight}px`,
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="flex flex-col gap-1.5">
                <MenuItemButton
                    icon={<Copy size={14} />}
                    label="Copy"
                    shortcut={localizeCommandToOS("C")}
                    onClick={() => {
                        navigator.clipboard.writeText(selectedText);
                        closeMenu();
                    }}
                />

                {!isHighlightInteraction && (
                    <MenuItemButton
                        icon={<Bookmark size={14} />}
                        label="Save"
                        shortcut={localizeCommandToOS("H")}
                        onMouseDown={preventMouseDown}
                        onClick={() => addHighlight(selectedText, false)}
                    />
                )}

                <MenuItemButton
                    icon={<Highlighter size={14} />}
                    label="Annotate"
                    shortcut={localizeCommandToOS("E")}
                    onMouseDown={preventMouseDown}
                    onClick={() => {
                        setIsAnnotating(true);
                        setTooltipPosition(null);
                        setSelectedText("");
                        if (!isHighlightInteraction) {
                            addHighlight(selectedText, true);
                        }
                    }}
                />

                <MenuItemButton
                    icon={<MessageCircle size={14} />}
                    label="Ask"
                    shortcut={localizeCommandToOS("A")}
                    onMouseDown={preventMouseDown}
                    onClick={() => {
                        setUserMessageReferences((prev) => Array.from(new Set([...prev, selectedText])));
                        closeMenu();
                    }}
                />

                {paperId && (
                    <MenuItemButton
                        icon={<Languages size={14} />}
                        label="Translate"
                        shortcut={localizeCommandToOS("T")}
                        testId="inline-translate-button"
                        onMouseDown={preventMouseDown}
                        onClick={() => requestTranslation(true)}
                    />
                )}

                {isHighlightInteraction && activeHighlight && (
                    <MenuItemButton
                        icon={<Minus size={14} />}
                        label="Delete"
                        shortcut={localizeCommandToOS("D")}
                        destructive
                        onMouseDown={preventMouseDown}
                        onClick={() => {
                            removeHighlight(activeHighlight);
                            closeMenu();
                        }}
                    />
                )}

                <MenuItemButton
                    icon={<X size={14} />}
                    label="Close"
                    shortcut="Esc"
                    onClick={closeMenu}
                />

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
