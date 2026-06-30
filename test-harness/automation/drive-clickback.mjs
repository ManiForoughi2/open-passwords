import { fileURLToPath } from "url";
// regression: dropdown must reappear on click-away then click-back
// bug was a scroll listener destroying it on the focus-scroll
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
const EXT = process.env.OP_EXT || fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const BASE = process.env.OP_BASE || "http://127.0.0.1:8799";
const ctx = await chromium.launchPersistentContext("/tmp/op-cb-" + Date.now(), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-first-run"],
});
ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
const page = await ctx.newPage();
await page.goto(`${BASE}/testbench.html`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(300);
const box = () => page.locator('[data-open-passwords="suggestions"]');
const results = [];
const ok = (n, c) => { results.push(c); console.log((c ? "PASS " : "FAIL ") + n); };
// fill card1 to reach the "already logged in" state the user hit
await page.locator("#u1").click(); await page.waitForTimeout(400);
if (await box().count()) { await box().locator("text=Click to autofill").click(); await page.waitForTimeout(600); }
let allShow = true;
for (let i = 0; i < 3; i++) {
  await page.locator("#u2").click(); await page.waitForTimeout(350);
  const shown = (await box().count()) > 0;
  ok(`cycle ${i}: dropdown shows on #u2`, shown);
  if (!shown) allShow = false;
  await page.locator("h1").click(); await page.waitForTimeout(250);
  ok(`cycle ${i}: hides after click away`, (await box().count()) === 0);
}
ok("dropdown reappears on every click-back", allShow);
await ctx.close();
const failed = results.filter((r) => !r).length;
console.log(`\n==== ${results.length - failed}/${results.length} PASS ====`);
process.exit(failed ? 1 : 0);
