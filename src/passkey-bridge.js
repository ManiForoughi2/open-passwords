// the MAIN-world guard cant read chrome.storage, so relay hidePasskeys via a window event
(() => {
  const push = (on) =>
    dispatchEvent(new Event(on ? "openpasswords:hide-passkeys-on" : "openpasswords:hide-passkeys-off"));
  chrome.storage?.local?.get({ hidePasskeys: false }, (d) => push(!!d.hidePasskeys));
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.hidePasskeys) push(!!changes.hidePasskeys.newValue);
  });
})();
