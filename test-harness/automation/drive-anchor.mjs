import { fileURLToPath } from "url";
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
const EXT = process.env.OP_EXT || fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const ctx = await chromium.launchPersistentContext("/tmp/op-anc-" + Date.now(), {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-first-run"],
});
ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8799/testbench.html", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(300);
const box = () => page.locator('[data-open-passwords="suggestions"]');
await page.locator("#u2").focus();
await page.waitForTimeout(400);
await box().locator("text=Click to autofill").click();
await page.waitForTimeout(600);
const u1 = await page.inputValue("#u1");
const u2 = await page.inputValue("#u2");
console.log(`after clicking offer on #u2:  u1="${u1}"  u2="${u2}"`);
const pass = u2 === "test@example.com" && u1 === "";
console.log(pass ? "PASS fill targets #u2 (the field acted on), not #u1" : "FAIL wrong field filled");
await ctx.close();
process.exit(pass ? 0 : 1);
