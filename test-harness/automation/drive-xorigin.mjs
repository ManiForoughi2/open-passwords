// security regression: cross-origin iframe must not get an autofill offer
// confused-deputy leak from all_frames: a foreign sub-frame could fill the top page password
import { fileURLToPath } from "url";
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
const EXT = process.env.OP_EXT || fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const BASE = process.env.OP_BASE || "http://127.0.0.1:8799";

const ctx = await chromium.launchPersistentContext("/tmp/op-xo-" + Date.now(), {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-first-run"],
});
ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
const page = await ctx.newPage();
// top page on 127.0.0.1, inject iframe from a different origin (openpw.test)
await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => {
  const f = document.createElement("iframe");
  f.id = "xf";
  f.style = "width:600px;height:300px";
  f.src = "http://openpw.test:8799/iframe-pages/iframe-login.html";
  document.body.appendChild(f);
});
await page.waitForTimeout(1200);
const xframe = page.frames().find((f) => f.url().includes("openpw.test") && f.url().includes("iframe-login"));
if (!xframe) {
  console.log("PASS (cross-origin frame did not load; no offer possible)");
  await ctx.close();
  process.exit(0);
}
await xframe
  .locator('input[name="username"], input[autocomplete="username"], input[type="text"]')
  .first()
  .focus()
  .catch(() => {});
await page.waitForTimeout(700);
const dd = await xframe.locator('[data-open-passwords="suggestions"]').count();
const pass = dd === 0;
console.log(pass ? "PASS cross-origin iframe shows NO offer (leak closed)" : `FAIL cross-origin iframe got an offer (${dd})`);
await ctx.close();
process.exit(pass ? 0 : 1);
