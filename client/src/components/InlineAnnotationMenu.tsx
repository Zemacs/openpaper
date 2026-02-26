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
import { Bookmark, Copy, Highlighter, MessageCircle, Minus, X } from "lucide-react";

import { type PaperHighlight } from "@/lib/schema";
import { FOCUS_CHAT_INPUT_EVENT } from "@/lib/events";

import { useSelectionTranslation } from "./hooks/useSelectionTranslation";
import { useSelectionShortcutConfig } from "./hooks/useSelectionShortcutConfig";
import SelectionShortcutHelp from "./SelectionShortcutHelp";
import { normalizeShortcutKeyFromKeyboardEvent } from "./selection-shortcuts";
import SelectionTranslationCard from "./SelectionTranslationCard";
import { Button } from "./ui/button";
import { CommandShortcut } from "./ui/command";

export type InlineMenuMode = "translation" | "actions";

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
    menuMode?: InlineMenuMode;
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

function normalizeKeyPart(value: string | number | null | undefined): string {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isEditableTarget(target: EventTarget | null): boolean {
    const node = target as HTMLElement | null;
    if (!node) return false;
    if (node.isContentEditable) return true;
    const tagName = node.tagName?.toLowerCase();
    return tagName === "input" || tagName === "textarea" || tagName === "select";
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
        menuMode = "translation",
    } = props;

    const menuRef = useRef<HTMLDivElement>(null);
    const lastSelectionKeyRef = useRef("");
    const lastAnchorRef = useRef<{ x: number; y: number } | null>(null);
    const horizontalPlacementRef = useRef<"right" | "left" | null>(null);
    const verticalPlacementRef = useRef<"above" | "below" | null>(null);

    const isMenuOpen = Boolean(tooltipPosition);
    const effectiveMenuMode: InlineMenuMode = isHighlightInteraction ? "actions" : menuMode;
    const isActionMenuMode = effectiveMenuMode === "actions";
    const [isMounted, setIsMounted] = useState(false);
    const [menuLayout, setMenuLayout] = useState<MenuLayout | null>(null);
    const [isTranslationVisible, setIsTranslationVisible] = useState(false);
    const [isHelpVisible, setIsHelpVisible] = useState(false);

    const {
        bindings,
        configError,
        updateBinding,
        resetBindings,
    } = useSelectionShortcutConfig();

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
        setIsTranslationVisible(false);
        setIsHelpVisible(false);
        clearTranslation();
    }, [clearTranslation, setIsAnnotating, setSelectedText, setTooltipPosition]);

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

    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(selectedText);
        closeMenu();
    }, [closeMenu, selectedText]);

    const handleSave = useCallback(() => {
        addHighlight(selectedText, false);
        closeMenu();
    }, [addHighlight, closeMenu, selectedText]);

    const handleAnnotate = useCallback(() => {
        setIsAnnotating(true);
        setTooltipPosition(null);
        setSelectedText("");
        if (!isHighlightInteraction) {
            addHighlight(selectedText, true);
        }
    }, [
        addHighlight,
        isHighlightInteraction,
        selectedText,
        setIsAnnotating,
        setSelectedText,
        setTooltipPosition,
    ]);

    const handleAsk = useCallback(() => {
        setUserMessageReferences((prev) => Array.from(new Set([...prev, selectedText])));
        window.dispatchEvent(new CustomEvent(FOCUS_CHAT_INPUT_EVENT));
        closeMenu();
    }, [closeMenu, selectedText, setUserMessageReferences]);

    const handleDelete = useCallback(() => {
        if (!activeHighlight) return;
        removeHighlight(activeHighlight);
        closeMenu();
    }, [activeHighlight, closeMenu, removeHighlight]);

    const calculateMenuLayout = useCallback(() => {
        if (!tooltipPosition) {
            setMenuLayout(null);
            lastAnchorRef.current = null;
            horizontalPlacementRef.current = null;
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
            horizontalPlacementRef.current = null;
            verticalPlacementRef.current = null;
        }

        const minLeft = MENU_VIEWPORT_PADDING;
        const maxLeft = viewportWidth - width - MENU_VIEWPORT_PADDING;
        const preferredRightLeft = anchorX + MENU_OFFSET;
        const preferredLeftLeft = anchorX - width - MENU_OFFSET;
        const canPlaceRight = preferredRightLeft <= maxLeft;
        const canPlaceLeft = preferredLeftLeft >= minLeft;

        if (!horizontalPlacementRef.current) {
            if (canPlaceRight) {
                horizontalPlacementRef.current = "right";
            } else if (canPlaceLeft) {
                horizontalPlacementRef.current = "left";
            } else {
                horizontalPlacementRef.current = "right";
            }
        }

        const rawLeft = horizontalPlacementRef.current === "left"
            ? preferredLeftLeft
            : preferredRightLeft;
        const left = Math.max(minLeft, Math.min(rawLeft, maxLeft));

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
        if (isActionMenuMode) {
            setIsTranslationVisible(false);
            setIsHelpVisible(false);
            clearTranslation();
            return;
        }

        const trimmedSelectedText = selectedText.trim();
        if (!isMenuOpen || !trimmedSelectedText) {
            lastSelectionKeyRef.current = "";
            setIsTranslationVisible(false);
            setIsHelpVisible(false);
            clearTranslation();
            return;
        }

        const selectionKey = [
            normalizeKeyPart(trimmedSelectedText),
            normalizeKeyPart(selectedPageNumber),
            normalizeKeyPart(selectedContextBefore),
            normalizeKeyPart(selectedContextAfter),
        ].join("|");

        if (selectionKey !== lastSelectionKeyRef.current) {
            lastSelectionKeyRef.current = selectionKey;
            setIsTranslationVisible(false);
            setIsHelpVisible(false);
            clearTranslation();
        }
    }, [
        selectedText,
        selectedPageNumber,
        selectedContextBefore,
        selectedContextAfter,
        isMenuOpen,
        isActionMenuMode,
        clearTranslation,
    ]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (!isMenuOpen || isEditableTarget(event.target) || event.repeat) {
                return;
            }
            if (event.isComposing) {
                return;
            }

            if (event.key === "Escape") {
                if (isHelpVisible) {
                    setIsHelpVisible(false);
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                closeMenu();
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            if (isActionMenuMode) {
                if (event.metaKey || event.ctrlKey || event.altKey) {
                    return;
                }

                const key = event.key.toLowerCase();
                if (key === "c") {
                    handleCopy();
                } else if (key === "s" && !isHighlightInteraction) {
                    handleSave();
                } else if (key === "n") {
                    handleAnnotate();
                } else if (key === "a") {
                    handleAsk();
                } else if (key === "d" && isHighlightInteraction && activeHighlight) {
                    handleDelete();
                } else if (key === "x") {
                    closeMenu();
                } else {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            if (isSelectionInProgress || event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }

            const normalizedKey = normalizeShortcutKeyFromKeyboardEvent(event);
            if (!normalizedKey) {
                return;
            }

            if (normalizedKey === bindings.help) {
                setIsHelpVisible((prev) => !prev);
                setIsTranslationVisible(false);
            } else if (normalizedKey === bindings.translate) {
                setIsHelpVisible(false);
                setIsTranslationVisible(true);
                requestTranslation(false);
            } else if (normalizedKey === bindings.chat) {
                handleAsk();
            } else if (normalizedKey === bindings.highlight) {
                handleSave();
            } else if (normalizedKey === bindings.annotate) {
                handleAnnotate();
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
        isMenuOpen,
        isActionMenuMode,
        selectedText,
        isHighlightInteraction,
        activeHighlight,
        closeMenu,
        isHelpVisible,
        isSelectionInProgress,
        bindings,
        requestTranslation,
        handleAsk,
        handleAnnotate,
        handleCopy,
        handleDelete,
        handleSave,
    ]);

    if (!tooltipPosition || !menuLayout || !isMounted) return null;
    if (!isActionMenuMode && !isTranslationVisible && !isHelpVisible) return null;

    const preventMouseDown = (e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
    };

    const menuNode = (
        <div
            ref={menuRef}
            data-testid="inline-annotation-menu"
            data-menu-mode={effectiveMenuMode}
            className={[
                "fixed z-[2147483000] overflow-y-auto",
                isActionMenuMode
                    ? "rounded-lg border border-border bg-background p-3 shadow-lg"
                    : "border-0 bg-transparent p-0 shadow-none",
            ].join(" ")}
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
                {isActionMenuMode ? (
                    <>
                        <div className="px-1 text-[11px] text-muted-foreground" data-testid="inline-action-mode">
                            Action mode: press a key to execute
                        </div>
                        <MenuItemButton
                            icon={<Copy size={14} />}
                            label="Copy"
                            shortcut="C"
                            testId="inline-action-copy"
                            onClick={handleCopy}
                        />

                        {!isHighlightInteraction && (
                            <MenuItemButton
                                icon={<Bookmark size={14} />}
                                label="Save"
                                shortcut="S"
                                testId="inline-action-save"
                                onMouseDown={preventMouseDown}
                                onClick={handleSave}
                            />
                        )}

                        <MenuItemButton
                            icon={<Highlighter size={14} />}
                            label="Annotate"
                            shortcut="N"
                            testId="inline-action-annotate"
                            onMouseDown={preventMouseDown}
                            onClick={handleAnnotate}
                        />

                        <MenuItemButton
                            icon={<MessageCircle size={14} />}
                            label="Ask"
                            shortcut="A"
                            testId="inline-action-ask"
                            onMouseDown={preventMouseDown}
                            onClick={handleAsk}
                        />

                        {isHighlightInteraction && activeHighlight && (
                            <MenuItemButton
                                icon={<Minus size={14} />}
                                label="Delete"
                                shortcut="D"
                                testId="inline-action-delete"
                                destructive
                                onMouseDown={preventMouseDown}
                                onClick={handleDelete}
                            />
                        )}

                        <MenuItemButton
                            icon={<X size={14} />}
                            label="Close"
                            shortcut="Esc"
                            testId="inline-action-close"
                            onClick={closeMenu}
                        />
                    </>
                ) : isHelpVisible ? (
                    <SelectionShortcutHelp
                        selectedText={selectedText}
                        bindings={bindings}
                        configError={configError}
                        onUpdateBinding={updateBinding}
                        onResetBindings={resetBindings}
                    />
                ) : (
                    <div data-testid="inline-translation-window">
                        <SelectionTranslationCard
                            translation={translation}
                            isLoading={isTranslating}
                            error={translationError}
                            standalone
                            onRetry={() => {
                                void retryLast();
                            }}
                        />
                    </div>
                )}
            </div>
        </div>
    );

    return createPortal(menuNode, document.body);
}
