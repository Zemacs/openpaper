import { expect, test } from "@playwright/test";

function mockWordResponse() {
    return {
        mode: "word",
        detected_mode: "word",
        source_text: "mitigate",
        target_language: "zh-CN",
        result: {
            ipa_us: "/ˈmɪtəˌɡeɪt/",
            ipa_uk: "/ˈmɪtɪɡeɪt/",
            pos: "verb",
            primary_translation_cn: "缓解",
            context_translation_cn: "在本文中表示降低不利影响",
            meaning_explainer_cn: "强调降低不利影响，而非完全消除。",
            usage_notes_cn: ["常搭配 risk / bias / impact"],
            collocations: ["mitigate risk", "mitigate bias"],
            example_context_en: "Our method mitigates domain shift.",
            example_context_cn: "我们的方法能缓解域偏移。",
            example_general_en: "Policies can mitigate climate risks.",
            example_general_cn: "政策可以缓解气候风险。",
        },
        meta: {
            confidence: 0.92,
            context_relevance_score: 0.96,
            cached: false,
            latency_ms: 35,
        },
    };
}

function mockSentenceResponse() {
    return {
        mode: "sentence",
        detected_mode: "sentence",
        source_text: "Our method improves cross-domain generalization.",
        target_language: "zh-CN",
        result: {
            concise_translation_cn: "我们的方法提升了跨域泛化能力。",
            context_translation_cn: "该句强调方法在不同域之间的泛化提升。",
            one_line_explain_cn: "说明模型在跨域场景下更稳健。",
            key_terms: [
                { en: "cross-domain", cn: "跨域" },
                { en: "generalization", cn: "泛化能力" },
            ],
        },
        meta: {
            confidence: 0.9,
            context_relevance_score: 0.94,
            cached: false,
            latency_ms: 48,
        },
    };
}

test("selection stays silent until shortcut is pressed", async ({ page }) => {
    let translateCalls = 0;
    await page.route("**/api/translate/selection", async (route) => {
        translateCalls += 1;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockWordResponse()),
        });
    });

    await page.goto("/translation-e2e");
    await page.waitForTimeout(400);

    await expect(page.getByTestId("inline-annotation-menu")).toHaveCount(0);
    await expect.poll(() => translateCalls).toBe(0);
});

test("shortcut f triggers translation panel", async ({ page }) => {
    let translateCalls = 0;
    await page.route("**/api/translate/selection", async (route) => {
        translateCalls += 1;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockWordResponse()),
        });
    });

    await page.goto("/translation-e2e");
    await page.keyboard.press("f");

    const card = page.getByTestId("selection-translation-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("在本文中表示降低不利影响");
    await expect.poll(() => translateCalls).toBe(1);
});

test("shortcut ? opens help and custom bindings take effect", async ({ page }) => {
    let translateCalls = 0;
    await page.route("**/api/translate/selection", async (route) => {
        translateCalls += 1;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockWordResponse()),
        });
    });

    await page.goto("/translation-e2e");

    await page.keyboard.press("?");
    await expect(page.getByTestId("selection-shortcut-help")).toBeVisible();

    await page.getByTestId("selection-shortcut-select-translate").selectOption("t");

    await page.keyboard.press("?");
    await expect(page.getByTestId("selection-shortcut-help")).toHaveCount(0);

    await page.keyboard.press("f");
    await page.waitForTimeout(300);
    await expect.poll(() => translateCalls).toBe(0);

    await page.keyboard.press("t");
    await expect(page.getByTestId("selection-translation-card")).toBeVisible();
    await expect.poll(() => translateCalls).toBe(1);
});

test("shortcut c adds chat reference and exits selection", async ({ page }) => {
    await page.goto("/translation-e2e");

    await page.keyboard.press("c");

    await expect(page.getByTestId("translation-e2e-reference-count")).toContainText("1");
    await expect(page.getByTestId("translation-e2e-tooltip-position")).toContainText("closed");
});

test("shortcut e creates highlight and exits selection", async ({ page }) => {
    await page.goto("/translation-e2e");

    await page.keyboard.press("e");

    await expect(page.getByTestId("translation-e2e-highlight-count")).toContainText("1");
    await expect(page.getByTestId("translation-e2e-tooltip-position")).toContainText("closed");
});

test("shortcut n enters annotate flow", async ({ page }) => {
    await page.goto("/translation-e2e");

    await page.keyboard.press("n");

    await expect(page.getByTestId("translation-e2e-annotating")).toContainText("yes");
    await expect(page.getByTestId("translation-e2e-highlight-count")).toContainText("1");
});

test("selection shortcuts are blocked during drag", async ({ page }) => {
    let translateCalls = 0;
    await page.route("**/api/translate/selection", async (route) => {
        translateCalls += 1;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockWordResponse()),
        });
    });

    await page.goto("/translation-e2e");

    await page.getByTestId("translation-e2e-start-drag").click({ force: true });
    await expect(page.getByTestId("translation-e2e-selection-progress")).toContainText("yes");

    await page.keyboard.press("f");
    await page.waitForTimeout(300);
    await expect.poll(() => translateCalls).toBe(0);

    await page.getByTestId("translation-e2e-end-drag").click({ force: true });
    await expect(page.getByTestId("translation-e2e-selection-progress")).toContainText("no");

    await page.keyboard.press("f");
    await expect(page.getByTestId("selection-translation-card")).toBeVisible();
    await expect.poll(() => translateCalls).toBe(1);
});

test("long selection is trimmed to request limit when translating", async ({ page }) => {
    const requestLengths: number[] = [];

    await page.route("**/api/translate/selection", async (route) => {
        const body = route.request().postDataJSON() as { selected_text?: string };
        requestLengths.push((body.selected_text || "").length);
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockSentenceResponse()),
        });
    });

    await page.goto("/translation-e2e");
    await page.getByTestId("translation-e2e-long-case").click();
    await page.keyboard.press("f");

    const card = page.getByTestId("selection-translation-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("跨域泛化能力");
    await expect.poll(() => requestLengths.some((len) => len === 5000)).toBeTruthy();
});

test("escape dismisses selected state", async ({ page }) => {
    await page.goto("/translation-e2e");

    await page.keyboard.press("Escape");

    await expect(page.getByTestId("translation-e2e-tooltip-position")).toContainText("closed");
    await expect(page.getByTestId("translation-e2e-selected-text")).toContainText("Selected:");
});
