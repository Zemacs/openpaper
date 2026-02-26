import { expect, test, type Page } from "@playwright/test";

const PAPER_ID = "00000000-0000-0000-0000-00000000c0de";

function streamBody(chunks: Array<{ type: string; content: unknown }>) {
    return chunks.map((chunk) => JSON.stringify(chunk)).join("END_OF_STREAM") + "END_OF_STREAM";
}

async function mockCommonSessionEndpoints(page: Page) {
    await page.route("**/api/auth/me", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                success: true,
                user: {
                    id: "u-1",
                    email: "e2e@example.com",
                    name: "E2E User",
                    picture: "",
                    is_active: true,
                },
            }),
        });
    });

    await page.route("**/api/subscription/usage", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                usage: {
                    chat_credits_used: 0,
                    chat_credits_remaining: 100,
                    paper_uploads: 0,
                    paper_uploads_remaining: 10,
                    knowledge_base_size: 0,
                    knowledge_base_size_remaining: 1024,
                    audio_overviews_used: 0,
                    audio_overviews_remaining: 10,
                    projects: 0,
                    projects_remaining: 10,
                    data_tables_used: 0,
                    data_tables_remaining: 10,
                    discover_searches_used: 0,
                    discover_searches_remaining: 10,
                },
            }),
        });
    });
}

test("creates conversation when none exists and sends starter prompt", async ({ page }) => {
    const conversationId = "11111111-1111-1111-1111-111111111111";
    let chatRequestConversationId: string | null = null;

    await mockCommonSessionEndpoints(page);

    await page.route("**/api/message/models", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ models: {} }),
        });
    });

    await page.route(`**/api/paper/conversation?paper_id=${PAPER_ID}`, async (route) => {
        await route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ message: "No conversations found" }),
        });
    });

    await page.route(`**/api/conversation/paper/${PAPER_ID}`, async (route) => {
        await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({ id: conversationId, title: "chat", messages: [] }),
        });
    });

    await page.route(`**/api/conversation/${conversationId}?page=1`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ messages: [] }),
        });
    });

    await page.route("**/api/message/chat/paper", async (route) => {
        const body = route.request().postDataJSON() as { conversation_id?: string };
        chatRequestConversationId = body.conversation_id || null;
        await route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: streamBody([
                { type: "content", content: "这是会话初始化后的回答。" },
                { type: "references", content: { citations: [] } },
            ]),
        });
    });

    await page.goto("/chat-e2e");

    const starter = page.getByTestId("starter-question-1");
    await expect(starter).toBeVisible({ timeout: 10000 });
    await starter.click();

    await expect(page.getByText("这是会话初始化后的回答。")).toBeVisible();
    await expect.poll(() => chatRequestConversationId).toBe(conversationId);
});

test("retries stream when provider is busy and eventually succeeds", async ({ page }) => {
    const conversationId = "22222222-2222-2222-2222-222222222222";
    let chatCallCount = 0;

    await mockCommonSessionEndpoints(page);

    await page.route("**/api/message/models", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ models: {} }),
        });
    });

    await page.route(`**/api/paper/conversation?paper_id=${PAPER_ID}`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ id: conversationId }),
        });
    });

    await page.route(`**/api/conversation/${conversationId}?page=1`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ messages: [] }),
        });
    });

    await page.route("**/api/message/chat/paper", async (route) => {
        chatCallCount += 1;

        if (chatCallCount === 1) {
            await route.fulfill({
                status: 200,
                contentType: "text/event-stream",
                body: streamBody([
                    { type: "error", content: "LLM provider is busy. Please retry in a few seconds." },
                ]),
            });
            return;
        }

        await route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: streamBody([
                { type: "content", content: "忙时重试成功返回结果。" },
                { type: "references", content: { citations: [] } },
            ]),
        });
    });

    await page.goto("/chat-e2e");

    const starter = page.getByTestId("starter-question-1");
    await expect(starter).toBeVisible({ timeout: 10000 });
    await starter.click();

    await expect(page.getByText("忙时重试成功返回结果。")).toBeVisible();
    await expect.poll(() => chatCallCount).toBe(2);
    await expect(page.getByTestId("chat-stream-error")).toHaveCount(0);
});

test("stops retry loop and shows recoverable error when provider remains busy", async ({ page }) => {
    const conversationId = "33333333-3333-3333-3333-333333333333";
    let chatCallCount = 0;

    await mockCommonSessionEndpoints(page);

    await page.route("**/api/message/models", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ models: {} }),
        });
    });

    await page.route(`**/api/paper/conversation?paper_id=${PAPER_ID}`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ id: conversationId }),
        });
    });

    await page.route(`**/api/conversation/${conversationId}?page=1`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ messages: [] }),
        });
    });

    await page.route("**/api/message/chat/paper", async (route) => {
        chatCallCount += 1;
        await route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: streamBody([
                { type: "error", content: "LLM provider is busy. Please retry in a few seconds." },
            ]),
        });
    });

    await page.goto("/chat-e2e");

    const starter = page.getByTestId("starter-question-1");
    await expect(starter).toBeVisible({ timeout: 10000 });
    await starter.click();

    await expect(page.getByTestId("chat-stream-error")).toBeVisible();
    await expect.poll(() => chatCallCount).toBe(3);
});
