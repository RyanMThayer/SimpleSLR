import { expect, test } from "@playwright/test";

/**
 * Public-surface smoke: every page a signed-out visitor can reach
 * renders with its expected content and the security headers are on.
 * Nothing here touches Supabase or needs an account.
 */

test("landing page renders with the hero and a sign in path", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.getByRole("link", { name: "Start a review" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
  await expect(page.getByText("What SimpleSLR covers")).toBeVisible();
});

test("login page offers email sign in and click-to-load Google", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("h1")).toHaveText("Sign in");
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  // Click-to-load placeholder: no Google script may load with the page.
  await expect(page.getByText("Continue with Google")).toBeVisible();
  const googleRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("accounts.google.com")) googleRequests.push(r.url());
  });
  await page.waitForTimeout(500);
  expect(googleRequests).toHaveLength(0);
});

test("legal pages carry the provider identity", async ({ page }) => {
  await page.goto("/imprint");
  await expect(page.locator("h1")).toHaveText("Imprint");
  await expect(page.getByText("Ryan Thayer").first()).toBeVisible();
  await expect(page.getByText("56218 Mülheim-Kärlich").first()).toBeVisible();

  await page.goto("/privacy");
  await expect(page.locator("h1")).toHaveText("Privacy policy");
  await expect(page.getByText("Who is responsible")).toBeVisible();

  await page.goto("/terms");
  await expect(page.locator("h1")).toHaveText("Terms of service");
});

test("references page lists the methodological literature", async ({ page }) => {
  await page.goto("/references");
  await expect(page.locator("h1")).toHaveText("References");
  await expect(page.getByText("The PRISMA 2020 statement", { exact: false })).toBeVisible();
  await expect(
    page.getByText("Analyzing the past to prepare for the future", { exact: false })
  ).toBeVisible();
  // Every DOI link resolves through doi.org.
  const hrefs = await page
    .locator('a[href^="https://doi.org/"]')
    .evaluateAll((els) => els.length);
  expect(hrefs).toBeGreaterThan(5);
});

test("security headers are set", async ({ request }) => {
  const res = await request.get("/");
  expect(res.headers()["content-security-policy"]).toBeTruthy();
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
});

test("unknown routes return the 404 page", async ({ page }) => {
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
});
