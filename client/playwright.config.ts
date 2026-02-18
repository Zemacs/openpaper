import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: true,
    retries: process.env.CI ? 2 : 0,
    reporter: "list",
    use: {
        baseURL: "http://127.0.0.1:3100",
        trace: "on-first-retry",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: {
        command: "NEXT_PUBLIC_ENABLE_E2E_HARNESS=true yarn dev -p 3100",
        cwd: __dirname,
        url: "http://127.0.0.1:3100",
        timeout: 120 * 1000,
        reuseExistingServer: !process.env.CI,
    },
});
