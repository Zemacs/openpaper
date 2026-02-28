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
    await expect(images.first().locator("img")).toHaveAttribute("src", /data:image\/svg\+xml/);
    const geometry = await page.evaluate(() => {
        const block = document.querySelector("[data-testid='article-image-block']");
        const stage = block?.querySelector(".article-image-stage");
        const image = block?.querySelector("img");
        const blockRect = block?.getBoundingClientRect();
        const stageRect = stage?.getBoundingClientRect();
        const imageRect = image?.getBoundingClientRect();
        return {
            blockWidth: blockRect?.width || 0,
            stageWidth: stageRect?.width || 0,
            imageWidth: imageRect?.width || 0,
            blockLeft: blockRect?.left || 0,
            stageLeft: stageRect?.left || 0,
        };
    });
    expect(geometry.stageWidth).toBeLessThanOrEqual(geometry.blockWidth);
    expect(geometry.stageLeft).toBeGreaterThanOrEqual(geometry.blockLeft);
    expect(Math.abs((geometry.stageLeft - geometry.blockLeft) * 2 - (geometry.blockWidth - geometry.stageWidth))).toBeLessThanOrEqual(6);
    expect(geometry.imageWidth).toBeGreaterThan(0);
    expect(geometry.stageWidth - geometry.imageWidth).toBeLessThanOrEqual(8);
});

test("article reader renders structured equation and table blocks", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const equation = page.getByTestId("article-equation-block").first();
    await expect(equation).toBeVisible();
    await expect(equation.locator(".katex-display")).toHaveCount(1);
    await expect(equation).toContainText("(1)");
    const table = page.getByTestId("article-table-block").first();
    await expect(table).toBeVisible();
    await expect(table).toContainText("Benchmark snapshot (multi-level header)");
    await expect(table).toContainText("BLEU 28.4");
    await expect(table).toContainText("Note: BLEU reported on WMT14 benchmark splits.");
    await expect(table.getByTestId("article-table")).toBeVisible();
    await expect(table.locator(".katex")).toHaveCount(1);
    await expect(table.locator("th strong", { hasText: "Task Group" })).toHaveCount(1);
    await expect(table.locator("tbody em", { hasText: "BLEU" })).toHaveCount(1);
    await expect(table.locator("colgroup col")).toHaveCount(4);
    await expect(table.locator("th[colspan='2']", { hasText: "Language Pair" })).toHaveCount(1);
    await expect(table.locator("th[rowspan='2']", { hasText: "Task Group" })).toHaveCount(1);
    const geometry = await page.evaluate(() => {
        const rail = document.querySelector("[data-testid='article-progress-rail']");
        const block = document.querySelector("[data-testid='article-table-block']");
        const paragraph = document.querySelector("#article-container article p");
        const railRect = rail?.getBoundingClientRect();
        const blockRect = block?.getBoundingClientRect();
        const paragraphRect = paragraph?.getBoundingClientRect();
        const tableEl = document.querySelector("[data-testid='article-table']");
        const tableShell = tableEl?.parentElement;
        return {
            railRight: railRect?.right || 0,
            blockLeft: blockRect?.left || 0,
            paragraphLeft: paragraphRect?.left || 0,
            tableWidth: tableEl?.getBoundingClientRect().width || 0,
            blockWidth: blockRect?.width || 0,
            paragraphWidth: paragraphRect?.width || 0,
            tableShellClientWidth: tableShell?.clientWidth || 0,
            tableShellScrollWidth: tableShell?.scrollWidth || 0,
        };
    });
    expect(geometry.blockLeft).toBeGreaterThan(geometry.railRight + 8);
    expect(geometry.tableWidth).toBeGreaterThanOrEqual(Math.min(geometry.blockWidth, 640));
    expect(Math.abs(geometry.blockLeft - geometry.paragraphLeft)).toBeLessThanOrEqual(8);
    expect(Math.abs(geometry.blockWidth - geometry.paragraphWidth)).toBeLessThanOrEqual(18);
    expect(geometry.tableShellScrollWidth - geometry.tableShellClientWidth).toBeLessThanOrEqual(4);
    const reference = page.getByTestId("article-reference-block").first();
    await expect(reference).toBeVisible();
    await expect(reference).toContainText("Attention is all you need");
    await expect(reference.getByTestId("article-reference-link")).toHaveAttribute("href", "https://arxiv.org/abs/1706.03762");
});

test("table of contents tracks headings and supports click navigation", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const toc = page.getByTestId("article-toc-rail");
    await expect(toc).toBeVisible();
    const tocLinks = page.getByTestId("article-toc-link");
    await expect(tocLinks).toHaveCount(2);
    await expect(tocLinks.nth(0)).toContainText("Method");
    await expect(tocLinks.nth(1)).toContainText("Efficiency");
    await expect(tocLinks.nth(0)).toHaveClass(/article-toc-link-active/);

    await tocLinks.nth(1).click();
    await expect.poll(async () => page.evaluate(() => window.location.hash)).toBe("#article-heading-h3-efficiency");
    await expect(tocLinks.nth(1)).toHaveClass(/article-toc-link-active/);
});

test("article reader preserves structured inline runs for citations, math, and emphasis", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const paragraph = page.locator("#article-container article p").nth(1);
    await expect(paragraph).toBeVisible();
    const citationLink = paragraph.getByRole("link", { name: /Dosovitskiy et al., 2021/ });
    await expect(citationLink).toHaveAttribute("data-href", "#article-ref-ref-7");
    await expect(paragraph.getByRole("link", { name: /Vaswani et al., 2017/ })).toHaveAttribute("data-href", "#article-ref-ref-1");
    await expect(paragraph.locator(".katex")).toHaveCount(1);
    await expect(paragraph.locator("em")).toHaveText("architecture");
    await expect(paragraph.locator("strong")).toHaveText("robust");
    await expect(paragraph.locator("code")).toHaveText("token budgets");
    await expect(paragraph.locator("sub")).toHaveText("2");
    await expect(paragraph.locator("sup")).toHaveText("2");
    await expect(paragraph.locator(".article-inline-smallcaps")).toHaveText("latent priors");
    await expect(paragraph.locator(".article-inline-underline")).toHaveText("careful calibration");
    await expect(paragraph.locator("del")).toContainText("obsolete heuristics");
});

test("reference section is collapsed by default and can expand", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const section = page.getByTestId("article-reference-section");
    await expect(section).toBeVisible();
    await expect(page.getByTestId("article-reference-block")).toHaveCount(7);
    await expect(page.getByTestId("article-reference-toggle")).toContainText("Expand all (7)");

    await page.getByTestId("article-reference-toggle").click();
    await expect(page.getByTestId("article-reference-toggle")).toContainText("Collapse");
});

test("internal citation expands references and focuses the target entry", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const toggle = page.getByTestId("article-reference-toggle");
    await expect(toggle).toContainText("Expand all (7)");

    const citationLink = page.locator("#article-container article p").nth(1).getByRole("link", { name: /Dosovitskiy et al., 2021/ });
    await citationLink.click();

    await expect(toggle).toContainText("Collapse");
    await expect(page.getByTestId("article-reference-return")).toBeVisible();
    const targetReference = page.locator("#article-ref-ref-7");
    await expect(targetReference).toHaveAttribute("data-article-citation-focus", "true");
    await expect(targetReference).toHaveClass(/article-reference-card-jump-target/);
    await expect.poll(async () => page.evaluate(() => window.location.hash)).toBe("#article-ref-ref-7");

    await page.getByTestId("article-reference-return").click();
    await expect(page.getByTestId("article-reference-return")).toHaveCount(0);
    await expect(citationLink).toHaveClass(/article-citation-source-returned/);
    await expect.poll(async () => page.evaluate(() => window.location.hash)).toBe("");
});

test("reading progress rail stays to the left of the content column", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const geometry = await page.evaluate(() => {
        const rail = document.querySelector("[data-testid='article-progress-rail']");
        const track = document.querySelector("[data-testid='article-progress-fill']")?.parentElement;
        const fill = document.querySelector("[data-testid='article-progress-fill']");
        const paragraph = document.querySelector("#article-container article p");
        const railRect = rail?.getBoundingClientRect();
        const paragraphRect = paragraph?.getBoundingClientRect();
        const fillStyle = fill ? window.getComputedStyle(fill) : null;
        return {
            railWidth: railRect?.width || 0,
            railHeight: railRect?.height || 0,
            railRight: railRect?.right || 0,
            paragraphLeft: paragraphRect?.left || 0,
            fillTop: fillStyle?.top || "",
            trackHeight: track?.getBoundingClientRect().height || 0,
        };
    });

    expect(geometry.railHeight).toBeGreaterThan(geometry.railWidth * 10);
    expect(geometry.railRight).toBeLessThan(geometry.paragraphLeft);
    expect(geometry.trackHeight).toBeGreaterThan(120);
    expect(geometry.fillTop).toBe("0px");
});

test("citation hover and reference hover keep source and target visually linked", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const citationLink = page.locator("#article-container article p").nth(1).getByRole("link", { name: /Dosovitskiy et al., 2021/ });
    const targetReference = page.locator("#article-ref-ref-7");

    await citationLink.hover();
    await expect(targetReference).toHaveClass(/article-reference-card-linked/);

    await targetReference.hover();
    await expect(citationLink).toHaveClass(/article-citation-source-active/);
});

test("multi-citation hover keeps the hovered segment mapped to the correct reference only", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const paragraph = page.locator("#article-container article p").nth(1);
    const firstCitation = paragraph.getByRole("link", { name: /Dosovitskiy et al., 2021/ });
    const secondCitation = paragraph.getByRole("link", { name: /Vaswani et al., 2017/ });
    const firstReference = page.locator("#article-ref-ref-7");
    const secondReference = page.locator("#article-ref-ref-1");

    await secondCitation.hover();
    await expect(secondReference).toHaveClass(/article-reference-card-linked/);
    await expect(firstReference).not.toHaveClass(/article-reference-card-linked/);

    await firstCitation.hover();
    await expect(firstReference).toHaveClass(/article-reference-card-linked/);
    await expect(secondReference).not.toHaveClass(/article-reference-card-linked/);
});

test("article images support lightbox preview and original link", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const imageHitArea = page.getByTestId("article-image-block").first().locator(".article-image-hit-area");
    await imageHitArea.click();
    await expect(page.getByTestId("article-image-lightbox")).toHaveCount(0);
    await imageHitArea.dblclick();
    const lightbox = page.getByTestId("article-image-lightbox");
    await expect(lightbox).toBeVisible();
    await expect(page.getByTestId("article-image-lightbox-image")).toBeVisible();
    const previewPanelMetrics = await page.evaluate(() => {
        const panel = document.querySelector("[data-testid='article-preview-panel']");
        const rect = panel?.getBoundingClientRect();
        return {
            width: rect?.width || 0,
            height: rect?.height || 0,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        };
    });
    expect(previewPanelMetrics.width).toBeGreaterThan(previewPanelMetrics.viewportWidth * 0.9);
    expect(previewPanelMetrics.height).toBeGreaterThan(previewPanelMetrics.viewportHeight * 0.9);
    await expect(page.getByTestId("article-preview-zoom-value")).toHaveText("100%");
    await page.getByTestId("article-preview-scroll").hover();
    await page.mouse.wheel(0, -420);
    await expect(page.getByTestId("article-preview-zoom-value")).not.toHaveText("100%");
    await expect(page.getByTestId("article-image-open-original")).toHaveAttribute("href", /data:image\/svg\+xml/);

    await page.getByTestId("article-image-lightbox-close").click();
    await expect(lightbox).toHaveCount(0);
});

test("tables and equations support preview zoom with mouse wheel", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const table = page.getByTestId("article-table-block").first();
    await table.click({ position: { x: 80, y: 80 } });
    await expect(page.getByTestId("article-preview-lightbox")).toHaveCount(0);
    await table.dblclick({ position: { x: 80, y: 80 } });
    const tablePreview = page.getByTestId("article-preview-lightbox");
    await expect(tablePreview).toBeVisible();
    await expect(page.getByTestId("article-preview-table")).toBeVisible();
    await expect(page.getByTestId("article-preview-zoom-value")).toHaveText("100%");
    await page.getByTestId("article-preview-scroll").hover();
    await page.mouse.wheel(0, -420);
    await expect(page.getByTestId("article-preview-zoom-value")).not.toHaveText("100%");
    const previewTableMetrics = await page.evaluate(() => {
        const scaleFrame = document.querySelector("[data-testid='article-preview-scale-frame']");
        const firstCell = document.querySelector("[data-testid='article-preview-table'] [data-testid='article-table-cell']");
        const frameStyle = scaleFrame instanceof HTMLElement ? scaleFrame.style : null;
        const cellStyle = firstCell ? window.getComputedStyle(firstCell) : null;
        return {
            frameWidth: frameStyle?.width || "",
            userSelect: cellStyle?.userSelect || "",
        };
    });
    expect(previewTableMetrics.frameWidth).not.toBe("100%");
    expect(previewTableMetrics.userSelect).toBe("text");
    await page.getByTestId("article-preview-select-text").click();
    const previewTextArea = page.getByTestId("article-preview-textarea");
    await expect(previewTextArea).toBeVisible();
    await expect.poll(async () => {
        return previewTextArea.evaluate((node) => {
            if (!(node instanceof HTMLTextAreaElement)) {
                return 0;
            }
            return Math.max(0, node.selectionEnd - node.selectionStart);
        });
    }).toBeGreaterThan(0);
    await page.getByTestId("article-image-lightbox-close").click();
    await expect(tablePreview).toHaveCount(0);

    const equation = page.getByTestId("article-equation-block").first();
    await equation.click();
    await expect(page.getByTestId("article-preview-lightbox")).toHaveCount(0);
    await equation.dblclick();
    const equationPreview = page.getByTestId("article-preview-lightbox");
    await expect(equationPreview).toBeVisible();
    await expect(page.getByTestId("article-preview-equation-block")).toBeVisible();
    await page.getByTestId("article-preview-scroll").hover();
    await page.mouse.wheel(0, -420);
    await expect(page.getByTestId("article-preview-zoom-value")).not.toHaveText("100%");
    await page.getByTestId("article-image-lightbox-close").click();
    await expect(equationPreview).toHaveCount(0);
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
    expect(geometry.overlayCount).toBeGreaterThan(0);
    expect(geometry.paragraphWidth).toBeGreaterThan(300);
    expect(geometry.minOverlayLeft).toBeGreaterThanOrEqual(geometry.paragraphLeft - 3);
    expect(geometry.maxOverlayRight).toBeLessThanOrEqual(geometry.paragraphRight + 3);
    expect(geometry.overlayCount).toBeLessThanOrEqual(3);
    expect(geometry.maxOverlayWidth).toBeGreaterThan(geometry.paragraphWidth * 0.3);
    expect(geometry.maxOverlayWidth).toBeLessThanOrEqual(geometry.paragraphWidth + 4);
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

test("selection overlay stays within frame budget for long drags", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const paragraph = page.locator("#article-container article p").nth(2);
    await paragraph.scrollIntoViewIfNeeded();
    const box = await paragraph.boundingBox();
    if (!box) {
        throw new Error("Failed to resolve long paragraph bounds for selection perf test.");
    }

    const startX = Math.round(box.x - 24);
    const startY = Math.round(box.y + 12);
    const endX = Math.round(box.x + box.width + 24);
    const endY = Math.round(box.y + box.height - 12);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 42 });
    await page.mouse.up();
    await waitForArticleSelectionReady(page);

    const metrics = await page.locator("#article-container").evaluate((element) => {
        const container = element as HTMLDivElement;
        return {
            ms: Number(container.getAttribute("data-article-last-selection-ms") || "0"),
            rectCount: Number(container.getAttribute("data-article-last-selection-rect-count") || "0"),
        };
    });

    expect(metrics.rectCount).toBeGreaterThan(0);
    expect(metrics.rectCount).toBeLessThanOrEqual(3);
    expect(metrics.ms).toBeLessThan(20);
});

test("scroll telemetry stays within frame budget during rapid scrolling", async ({ page }) => {
    await gotoArticleReaderHarness(page);

    const metrics = await page.locator("#article-container").evaluate(async (element) => {
        const container = element as HTMLDivElement;
        const maxScrollable = Math.max(0, container.scrollHeight - container.clientHeight);
        for (let index = 0; index <= 18; index += 1) {
            container.scrollTop = maxScrollable * (index / 18);
            container.dispatchEvent(new Event("scroll"));
            await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
        }
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
        return {
            ms: Number(container.getAttribute("data-article-last-scroll-ms") || "0"),
            percent: Number(container.getAttribute("data-article-last-scroll-percent") || "0"),
        };
    });

    expect(metrics.percent).toBeGreaterThanOrEqual(90);
    expect(metrics.ms).toBeLessThan(20);
});
