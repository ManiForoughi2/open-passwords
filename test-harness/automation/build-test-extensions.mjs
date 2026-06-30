// mock extension variants for headless tests: copy real src/, swap helper-backed
// handlers for mocks so no macOS helper or real PIN needed. output to .builds/
//   node build-test-extensions.mjs
// builds:
//   unlocked - inlineLogins returns 1 login; inlineFill pushes mock cred
//   multi    - inlineLogins returns 2 logins (chooser test)
//   locked   - inlineLogins reports locked (PIN-prompt test)
//   pinflow  - requestChallenge/verifyPin mocked (123456 unlocks); fill mocked

import { mkdir, rm, cp, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const OUT = join(HERE, ".builds");

const MOCK_INLINEFILL = `case "inlineFill": {
          const tab = sender.tab;
          const host = tab?.url ? new URL(tab.url).hostname.toLowerCase() : "";
          const resp = await chrome.tabs.sendMessage(tab.id, { type: "fill", username: "test@example.com", password: "TestPass123", expectedHost: host });
          sendResponse({ ok: true, filled: !!resp?.filled });
          break;
        }`;

function patchBackground(src, kind) {
  src = src.replace(/case "inlineFill": \{[\s\S]*?\n        \}/, MOCK_INLINEFILL);

  if (kind === "unlocked") {
    src = src.replace(
      /case "inlineLogins": \{[\s\S]*?\n        \}/,
      `case "inlineLogins": {
          sendResponse({ ok: true, locked: false, logins: [{ username: "test@example.com", sites: [] }] });
          break;
        }`,
    );
  } else if (kind === "multi") {
    src = src.replace(
      /case "inlineLogins": \{[\s\S]*?\n        \}/,
      `case "inlineLogins": {
          sendResponse({ ok: true, locked: false, logins: [{ username: "alice@example.com", sites: [] }, { username: "bob@work.com", sites: [] }] });
          break;
        }`,
    );
  } else if (kind === "locked") {
    src = src.replace(
      /case "inlineLogins": \{[\s\S]*?\n        \}/,
      `case "inlineLogins": {
          sendResponse({ ok: true, locked: true, logins: [] });
          break;
        }`,
    );
  } else if (kind === "pinflow") {
    src = src.replace(
      /case "inlineLogins": \{[\s\S]*?\n        \}/,
      `case "inlineLogins": {
          if (!globalThis.__unlocked) return sendResponse({ ok: true, locked: true, logins: [] });
          return sendResponse({ ok: true, locked: false, logins: [{ username: "test@example.com", sites: [] }] });
          break;
        }`,
    );
    src = src.replace(
      /case "requestChallenge":[\s\S]*?break;/,
      `case "requestChallenge":
          await new Promise((r) => setTimeout(r, 100));
          sendResponse({ ok: true, state: "needs_pin" });
          break;`,
    );
    src = src.replace(
      /case "verifyPin":[\s\S]*?break;/,
      `case "verifyPin":
          await new Promise((r) => setTimeout(r, 100));
          if (msg.pin === "123456") { globalThis.__unlocked = true; sendResponse({ ok: true, state: "unlocked" }); }
          else { sendResponse({ ok: false, error: "Incorrect PIN", state: "needs_pin" }); }
          break;`,
    );
  }
  return src;
}

const KINDS = ["unlocked", "multi", "locked", "pinflow"];

await rm(OUT, { recursive: true, force: true });
for (const kind of KINDS) {
  const dst = join(OUT, kind);
  await mkdir(dst, { recursive: true });
  for (const item of ["manifest.json", "src", "icons"]) {
    await cp(join(REPO, item), join(dst, item), { recursive: true });
  }
  const bgPath = join(dst, "src", "background.js");
  const bg = await readFile(bgPath, "utf8");
  await writeFile(bgPath, patchBackground(bg, kind));
  console.log(`built ${kind} -> ${dst}`);
}
console.log("\nDone. Test builds are in test-harness/automation/.builds/");
