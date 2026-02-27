import { expect, test, type Page } from "@playwright/test";

function mockWordResponse() {
    return {
        mode: "word",
        detected_mode: "word",
        source_text: "Transformer",
        target_language: "zh-CN",
        result: {
            ipa_us: "/trænsˈfɔːrmər/",
            ipa_uk: "/trænsˈfɔːmə/",
            pos: "noun",
            primary_translation_cn: "变换器",
            context_translation_cn: "这里指模型结构中的 Transformer 架构",
            meaning_explainer_cn: "在论文上下文中通常表示基于注意力机制的神经网络架构。",
            usage_notes_cn: ["常与 model / architecture 搭配"],
            collocations: ["Transformer model", "Transformer architecture"],
            example_context_en: "Transformer models improve parallelism.",
            example_context_cn: "Transformer 模型提升了并行性。",
            example_general_en: "We trained a compact Transformer.",
            example_general_cn: "我们训练了一个紧凑的 Transformer。",
        },
        meta: {
            confidence: 0.93,
            context_relevance_score: 0.95,
            cached: false,
            latency_ms: 30,
        },
    };
}

async function waitForArticleSelectionReady(page: Page) {
    await expect(page.getByTestId("article-e2e-selected-text")).not.toContainText("(empty)");
    await expect(page.getByTestId("article-e2e-tooltip")).not.toContainText("closed");
}

async function gotoArticleReaderHarness(page: Page) {
    await page.goto("/article-reader-e2e", { waitUntil: "load", timeout: 60000 });
    await expect(page.getByTestId("article-e2e-title")).toBeVisible();
}

test("article selection stays idle until shortcut is pressed", async ({ page }) => {
    let translateCalls = 0;

    await page.route("**/api/translate/selection", async (route) => {
        translateCalls += 1;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockWordResponse()),
        });
    });

    await gotoArticleReaderHarness(page);
    await page.getByTestId("article-e2e-select-sample").click();
    await waitForArticleSelectionReady(page);

    await expect(page.getByTestId("inline-annotation-menu")).toHaveCount(0);
    await expect.poll(() => translateCalls).toBe(0);
});

test("article reader renders structured image blocks", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const images = page.getByTestId("article-image-block");
    await expect(images.first()).toBeVisible();
    await expect(images.first()).toHaveAttribute("src", /data:image\/svg\+xml/);
});

test("shortcut f opens translation window for article selection", async ({ page }) => {
    let translateCalls = 0;

    await page.route("**/api/translate/selection", async (route) => {
        translateCalls += 1;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockWordResponse()),
        });
    });

    await gotoArticleReaderHarness(page);
    await page.getByTestId("article-e2e-select-sample").click();
    await waitForArticleSelectionReady(page);
    await page.keyboard.press("f");

    await expect(page.getByTestId("selection-translation-card")).toBeVisible();
    await expect(page.getByTestId("selection-translation-card")).toContainText("Transformer 架构");
    await expect.poll(() => translateCalls).toBe(1);
});

test("chat and highlight shortcuts work for article selection", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    await page.getByTestId("article-e2e-select-sample").click();
    await waitForArticleSelectionReady(page);
    await page.keyboard.press("c");
    await expect(page.getByTestId("article-e2e-reference-count")).toContainText("1");
    await expect(page.getByTestId("article-e2e-tooltip")).toContainText("closed");

    await page.getByTestId("article-e2e-select-sample").click();
    await waitForArticleSelectionReady(page);
    await page.keyboard.press("e");
    await expect(page.getByTestId("article-e2e-highlight-count")).toContainText("1");
    await expect(page.getByTestId("article-e2e-tooltip")).toContainText("closed");
});

test("selection uses custom tight overlay instead of native full-line highlight", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    await page.getByTestId("article-e2e-select-sample").click();
    await waitForArticleSelectionReady(page);

    const selectedRangeCount = await page.evaluate(() => window.getSelection()?.rangeCount || 0);
    expect(selectedRangeCount).toBe(0);
    await expect(page.getByTestId("article-selection-rect").first()).toBeVisible();

    const geometry = await page.evaluate(() => {
        const p = document.querySelector("#article-container article p");
        const pRect = p?.getBoundingClientRect();
        const overlays = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='article-selection-rect']"));
        const maxOverlayWidth = overlays.reduce((value, node) => {
            const rect = node.getBoundingClientRect();
            return Math.max(value, rect.width);
        }, 0);
        return {
            paragraphWidth: pRect?.width || 0,
            maxOverlayWidth,
        };
    });
    expect(geometry.paragraphWidth).toBeGreaterThan(100);
    expect(geometry.maxOverlayWidth).toBeLessThan(geometry.paragraphWidth - 8);
});

test("dragging from side gutters keeps article selection overlay inside text bounds", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const paragraph = page.locator("#article-container article p").nth(2);
    await paragraph.scrollIntoViewIfNeeded();
    const box = await paragraph.boundingBox();
    if (!box) {
        throw new Error("Failed to resolve long paragraph bounds for gutter drag test.");
    }

    const startX = Math.round(box.x - 28);
    const startY = Math.round(box.y + 10);
    const endX = Math.round(box.x + box.width + 28);
    const endY = Math.round(box.y + box.height - 12);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 50 });
    await page.mouse.up();
    await waitForArticleSelectionReady(page);

    const geometry = await page.evaluate(() => {
        const paragraphElement = document.querySelectorAll<HTMLElement>("#article-container article p")[2];
        const pRect = paragraphElement?.getBoundingClientRect();
        const overlays = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='article-selection-rect']"));
        const overlayRects = overlays.map((node) => node.getBoundingClientRect());
        const maxOverlayWidth = overlayRects.reduce((value, rect) => Math.max(value, rect.width), 0);
        const minOverlayLeft = overlayRects.reduce((value, rect) => Math.min(value, rect.left), Number.POSITIVE_INFINITY);
        const maxOverlayRight = overlayRects.reduce((value, rect) => Math.max(value, rect.right), Number.NEGATIVE_INFINITY);
        return {
            rangeCount: window.getSelection()?.rangeCount || 0,
            overlayCount: overlays.length,
            paragraphLeft: pRect?.left || 0,
            paragraphRight: pRect?.right || 0,
            paragraphWidth: pRect?.width || 0,
            maxOverlayWidth,
            minOverlayLeft,
            maxOverlayRight,
        };
    });

    expect(geometry.rangeCount).toBe(0);
    expect(geometry.overlayCount).toBeGreaterThan(6);
    expect(geometry.paragraphWidth).toBeGreaterThan(300);
    expect(geometry.minOverlayLeft).toBeGreaterThanOrEqual(geometry.paragraphLeft - 1);
    expect(geometry.maxOverlayRight).toBeLessThanOrEqual(geometry.paragraphRight + 1);
    expect(geometry.maxOverlayWidth).toBeLessThan(geometry.paragraphWidth * 0.6);
});

test("dragging selection renders custom overlay before mouse release", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const paragraph = page.locator("#article-container article p").nth(2);
    await paragraph.scrollIntoViewIfNeeded();
    const box = await paragraph.boundingBox();
    if (!box) {
        throw new Error("Failed to resolve long paragraph bounds for drag preview test.");
    }

    const startX = Math.round(box.x + 90);
    const startY = Math.round(box.y + 12);
    const endX = Math.round(box.x + box.width - 120);
    const endY = Math.round(box.y + box.height - 16);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 35 });

    await expect.poll(async () => {
        return page.evaluate(() => document.querySelectorAll("[data-testid='article-selection-rect']").length);
    }).toBeGreaterThan(0);

    const rangeCountDuringDrag = await page.evaluate(() => window.getSelection()?.rangeCount || 0);
    expect(rangeCountDuringDrag).toBeGreaterThan(0);

    await page.mouse.up();
    await waitForArticleSelectionReady(page);
});

test("outside click dismisses article selected state", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    await page.getByTestId("article-e2e-select-sample").click();
    await waitForArticleSelectionReady(page);

    await page.getByTestId("article-e2e-outside").click();
    await expect(page.getByTestId("article-e2e-tooltip")).toContainText("closed");
    await expect(page.getByTestId("article-e2e-selected-text")).toContainText("(empty)");
});

test("inside container click also dismisses article selected state", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    await page.getByTestId("article-e2e-select-sample").click();
    await waitForArticleSelectionReady(page);

    await page.locator("#article-container").click({ position: { x: 24, y: 24 } });
    await expect(page.getByTestId("article-e2e-tooltip")).toContainText("closed");
    await expect(page.getByTestId("article-e2e-selected-text")).toContainText("(empty)");
});

test("drag selection anchors tooltip near drag end and uses current selection", async ({ page }) => {
    const selectedTexts: string[] = [];

    await page.route("**/api/translate/selection", async (route) => {
        const body = route.request().postDataJSON() as { selected_text?: string };
        selectedTexts.push(body.selected_text || "");
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockWordResponse()),
        });
    });

    await gotoArticleReaderHarness(page);

    const paragraph = page.locator("#article-container article p").first();
    const box = await paragraph.boundingBox();
    if (!box) {
        throw new Error("Failed to resolve article paragraph bounds for drag test.");
    }

    const startX = Math.round(box.x + 10);
    const startY = Math.round(box.y + box.height / 2);
    const endX = Math.round(box.x + Math.min(box.width - 10, 220));

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, startY);
    await page.mouse.up();

    await waitForArticleSelectionReady(page);

    const tooltipText = await page.getByTestId("article-e2e-tooltip").innerText();
    const coords = tooltipText.match(/Tooltip:\s*([0-9.]+),([0-9.]+)/);
    expect(coords).not.toBeNull();
    const tooltipX = Number(coords?.[1] || "0");
    expect(Math.abs(tooltipX - endX)).toBeLessThanOrEqual(40);

    await page.keyboard.press("f");
    await expect(page.getByTestId("selection-translation-card")).toBeVisible();
    await expect.poll(() => selectedTexts.length).toBe(1);

    const selectedLabel = await page.getByTestId("article-e2e-selected-text").innerText();
    const selectedText = selectedLabel.replace(/^Selected:\s*/i, "").trim();
    expect(selectedTexts[0].length).toBeGreaterThan(0);
    expect(selectedText.toLowerCase()).toContain(selectedTexts[0].slice(0, 6).toLowerCase());
});

test("citation search term focuses and highlights relevant article block", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    await page.getByTestId("article-e2e-citation-search").click();

    const focusedBlock = page.locator("[data-article-citation-focus='true']");
    await expect(focusedBlock).toHaveCount(1);
    await expect(focusedBlock.first()).toContainText("long-range dependency");
    await expect(page.getByTestId("inline-annotation-menu")).toHaveCount(0);
});

test("reading progress updates when article container scrolls", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const progressLabel = page.getByTestId("article-reading-progress");
    await expect(progressLabel).toContainText("%");

    await page.locator("#article-container").evaluate((element) => {
        const container = element as HTMLDivElement;
        container.scrollTop = container.scrollHeight;
        container.dispatchEvent(new Event("scroll"));
    });

    await expect.poll(async () => {
        const text = await progressLabel.innerText();
        return Number((text || "0").replace("%", "").trim());
    }).toBeGreaterThanOrEqual(60);
});
