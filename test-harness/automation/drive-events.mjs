import { fileURLToPath } from "url";
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
const EXT = process.env.OP_EXT || fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const ctx=await chromium.launchPersistentContext("/tmp/op-ev-"+Date.now(),{headless:false,args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,"--headless=new","--no-first-run"]});
ctx.serviceWorkers()[0]||await ctx.waitForEvent("serviceworker",{timeout:10000}).catch(()=>null);
const page=await ctx.newPage();
await page.goto("http://127.0.0.1:8799/login-standard.html",{waitUntil:"domcontentloaded"});
await page.evaluate(()=>{
  window.__ev={input:0,change:0};
  for(const sel of ['input[name=username]','input[name=password]']){
    const el=document.querySelector(sel); if(!el)continue;
    el.addEventListener('input',()=>window.__ev.input++);
    el.addEventListener('change',()=>window.__ev.change++);
  }
});
await page.waitForTimeout(200);
const box=()=>page.locator('[data-open-passwords="suggestions"]');
await page.focus('input[name=username]'); await page.waitForTimeout(400);
await box().locator("text=Click to autofill").click(); await page.waitForTimeout(600);
const ev=await page.evaluate(()=>window.__ev);
const uval=await page.inputValue('input[name=username]');
const pval=await page.inputValue('input[name=password]');
console.log("events fired:",JSON.stringify(ev),"username:",uval,"password:",pval?"(filled)":"(empty)");
const pass = ev.input>=2 && ev.change>=2 && uval==="test@example.com" && pval.length>0;
console.log(pass?"PASS #9 input+change events fire on fill (no 'edit a char' bug)":"FAIL");
await ctx.close(); process.exit(pass?0:1);
