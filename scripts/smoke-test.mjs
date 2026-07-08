import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:8080/?cities=covina-ca&metric=uv&view=timeline&start=1993-11&end=2026-06";
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(`PAGE: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`CONSOLE: ${m.text()}`);
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("#page-subtitle", { timeout: 15000 }).catch(() => null);
await page.waitForTimeout(5000);

const bodyText = await page.locator("body").textContent({ timeout: 5000 });
const subtitleEl = page.locator("#page-subtitle");
const subtitle = (await subtitleEl.count()) ? (await subtitleEl.textContent()) : null;
const insightCards = await page.locator(".insight-card").count();
const failedText = await page.locator("body").textContent();
const loadFailed = failedText.includes("Failed to load data");

console.log(JSON.stringify({
  url,
  subtitle: subtitle?.trim(),
  insightCards,
  loadFailed: bodyText?.includes("Failed to load"),
  errors,
}, null, 2));

await browser.close();
process.exit(loadFailed || errors.length ? 1 : 0);
