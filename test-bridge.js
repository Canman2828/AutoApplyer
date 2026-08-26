// DEV-ONLY test bridge. Injected only on http://localhost:8765/* (see
// manifest.json content_scripts). Lets a local test page trigger the same
// actions as the popup, so the fill flow can be exercised end-to-end
// without clicking the toolbar icon. Safe to delete along with its
// manifest entry for a production build.
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.aafTest !== true) return;
  chrome.runtime.sendMessage({ type: e.data.type, payload: e.data.payload }, (res) => {
    window.postMessage({ aafTestResult: true, forType: e.data.type, res }, "*");
  });
});
document.documentElement.dataset.aafBridge = "ready";
