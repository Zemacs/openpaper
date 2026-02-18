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

test("shows translation card for selected word and expands details", async ({ page }) => {
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

    await expect(page.getByTestId("inline-annotation-menu")).toBeVisible();
    const card = page.getByTestId("selection-translation-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("在本文中表示降低不利影响");
    await expect.poll(() => translateCalls).toBe(1);

    await page.getByTestId("selection-translation-toggle").click();
    await expect(page.getByText("POS:")).toBeVisible();
    await expect(page.getByText("mitigate risk")).toBeVisible();
});

test("menu position follows tooltip updates", async ({ page }) => {
    await page.route("**/api/translate/selection", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockWordResponse()),
        });
    });

    await page.goto("/translation-e2e");
    const menu = page.getByTestId("inline-annotation-menu");
    await expect(menu).toBeVisible();

    const before = await menu.boundingBox();
    expect(before).not.toBeNull();

    await page.getByTestId("translation-e2e-move-tooltip").click({ force: true });
    await expect(page.getByTestId("translation-e2e-tooltip-position")).toContainText("620,240");

    const after = await menu.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.x).toBeGreaterThan(before!.x + 120);
    expect(after!.y).toBeGreaterThan(before!.y + 80);
});

test("does not retrigger translation when only tooltip position changes", async ({ page }) => {
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
    await expect(page.getByTestId("selection-translation-card")).toBeVisible();
    await expect.poll(() => translateCalls).toBe(1);

    await page.getByTestId("translation-e2e-move-tooltip").click({ force: true });
    await page.getByTestId("translation-e2e-reopen").click({ force: true });
    await page.getByTestId("translation-e2e-move-tooltip").click({ force: true });
    await page.waitForTimeout(500);

    await expect.poll(() => translateCalls).toBe(1);
});

test("shows error then retries successfully", async ({ page }) => {
    let translateCalls = 0;
    await page.route("**/api/translate/selection", async (route) => {
        translateCalls += 1;
        if (translateCalls <= 2) {
            await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({
                    detail: "LLM provider is busy. Please retry in a few seconds.",
                }),
            });
            return;
        }

        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockWordResponse()),
        });
    });

    await page.goto("/translation-e2e");

    await expect(page.getByTestId("selection-translation-error")).toBeVisible();
    await expect(page.getByText("Please retry")).toBeVisible();

    await page.getByTestId("selection-translation-retry").click();
    const card = page.getByTestId("selection-translation-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("在本文中表示降低不利影响");
    await expect.poll(() => translateCalls).toBe(3);
});

test("does not auto-translate while selection is in progress", async ({ page }) => {
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
    await expect(page.getByTestId("selection-translation-card")).toBeVisible();
    await expect.poll(() => translateCalls).toBe(1);

    await page.evaluate(() => {
        const button = document.querySelector('[data-testid="translation-e2e-start-drag"]') as HTMLButtonElement | null;
        button?.click();
    });
    await expect(page.getByTestId("translation-e2e-selection-progress")).toContainText("yes");

    await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const sentenceButton = buttons.find((btn) => btn.textContent?.includes("Sentence Case")) as HTMLButtonElement | undefined;
        sentenceButton?.click();
    });
    await page.waitForTimeout(400);
    await expect.poll(() => translateCalls).toBe(1);

    await page.evaluate(() => {
        const button = document.querySelector('[data-testid="translation-e2e-end-drag"]') as HTMLButtonElement | null;
        button?.click();
    });
    await expect(page.getByTestId("translation-e2e-selection-progress")).toContainText("no");
    await expect.poll(() => translateCalls).toBe(2);
    await expect(page.getByTestId("selection-translation-card")).toBeVisible();
});

test("keyboard shortcut triggers force translate", async ({ page }) => {
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
    await expect(page.getByTestId("selection-translation-card")).toBeVisible();
    await expect.poll(() => translateCalls).toBe(1);

    await page.evaluate(() => {
        window.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "t",
                ctrlKey: true,
                bubbles: true,
            }),
        );
    });
    await expect.poll(() => translateCalls).toBe(2);
});

test("keeps latest translation when an older request resolves later", async ({ page }) => {
    let translateCalls = 0;
    await page.route("**/api/translate/selection", async (route) => {
        translateCalls += 1;
        const body = route.request().postDataJSON() as { selected_text?: string };
        const selectedText = body?.selected_text || "";

        if (selectedText === "mitigate") {
            await page.waitForTimeout(900);
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(mockWordResponse()),
            });
            return;
        }

        await page.waitForTimeout(120);
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockSentenceResponse()),
        });
    });

    await page.goto("/translation-e2e");
    await expect.poll(() => translateCalls).toBe(1);

    await page.getByRole("button", { name: "Sentence Case" }).click();
    await expect.poll(() => translateCalls).toBe(2);

    const card = page.getByTestId("selection-translation-card");
    await expect(card).toContainText("跨域泛化能力");

    await page.waitForTimeout(1200);
    await expect(card).toContainText("跨域泛化能力");
    await expect(card).not.toContainText("在本文中表示降低不利影响");
});

test("menu position stays stable after translation result appears", async ({ page }) => {
    await page.route("**/api/translate/selection", async (route) => {
        await page.waitForTimeout(700);
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockWordResponse()),
        });
    });

    await page.goto("/translation-e2e");
    const menu = page.getByTestId("inline-annotation-menu");
    await expect(menu).toBeVisible();

    await page.waitForTimeout(80);
    const before = await menu.boundingBox();
    expect(before).not.toBeNull();

    await expect(page.getByTestId("selection-translation-card")).toBeVisible();
    const after = await menu.boundingBox();
    expect(after).not.toBeNull();

    const topDelta = Math.abs((after?.y || 0) - (before?.y || 0));
    expect(topDelta).toBeLessThan(48);
});
