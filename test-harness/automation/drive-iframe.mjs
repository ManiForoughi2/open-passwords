import { fileURLToPath } from "url";
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
const EXT = process.env.OP_EXT || fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const BASE = process.env.OP_BASE || "http://127.0.0.1:8799";
const ctx = await chromium.launchPersistentContext("/tmp/op-if-" + Date.now(), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-first-run"],
});
ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
const page = await ctx.newPage();
await page.goto(`${BASE}/tricky.html`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
const results = [];
const ok = (n, c) => { results.push(c); console.log((c ? "PASS " : "FAIL ") + n); };
const frame = page.frames().find((f) => f.url().includes("iframe-login"));
if (!frame) { console.log("FAIL: iframe-login frame not found"); await ctx.close(); process.exit(1); }
const userInFrame = frame.locator('input[autocomplete="username"], input[name="username"], input[type="text"]').first();
await userInFrame.focus().catch(() => {});
await page.waitForTimeout(700);
// dropdown renders inside the iframe document, not the top page
const ddInFrame = await frame.locator('[data-open-passwords="suggestions"]').count();
ok("same-origin iframe login: dropdown shows inside the frame", ddInFrame > 0);
await ctx.close();
const failed = results.filter((r) => !r).length;
console.log(`\n==== ${results.length - failed}/${results.length} PASS ====`);
process.exit(failed ? 1 : 0);
