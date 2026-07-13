// patch navigator.credentials.get in the page's own world: with the toggle on, swallow conditional passkey autofill; modal sign-in + password requests pass through
(() => {
  const creds = navigator.credentials;
  if (!creds || typeof creds.get !== "function") return;

  const orig = creds.get.bind(creds);
  let hide = false;
  addEventListener("openpasswords:hide-passkeys-on", () => (hide = true));
  addEventListener("openpasswords:hide-passkeys-off", () => (hide = false));

  creds.get = function (options) {
    const conditional = !!(options && options.mediation === "conditional" && options.publicKey);
    if (!hide || !conditional) return orig(options);
    // conditional get stays silent until the user picks; leave it pending (honour abort so the page can clean up)
    return new Promise((_, reject) => {
      const sig = options.signal;
      if (!sig) return;
      const bail = () => reject(new DOMException("Aborted", "AbortError"));
      if (sig.aborted) bail();
      else sig.addEventListener("abort", bail, { once: true });
    });
  };
})();
