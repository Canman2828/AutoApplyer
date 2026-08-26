const fillBtn = document.getElementById("fillBtn");
const statusEl = document.getElementById("status");
const unansweredEl = document.getElementById("unanswered");
const readinessEl = document.getElementById("readiness");

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function renderReadiness(profile, settings) {
  const checks = [
    { ok: !!profile?.firstName, label: "Profile saved" },
    { ok: !!settings?.apiKey, label: "API key set" },
    {
      ok: settings?.provider === "anthropic" || !!settings?.model,
      label: "Model chosen",
    },
  ];
  readinessEl.innerHTML = "";
  for (const c of checks) {
    const div = document.createElement("div");
    div.className = `check ${c.ok ? "ok" : "missing"}`;
    div.textContent = `${c.ok ? "✓" : "✗"} ${c.label}`;
    readinessEl.appendChild(div);
  }
  fillBtn.disabled = !checks.every((c) => c.ok);
}

function renderStatus(status) {
  if (!status) {
    statusEl.classList.add("hidden");
    unansweredEl.classList.add("hidden");
    return;
  }
  statusEl.classList.remove("hidden");
  statusEl.classList.toggle("error", status.state === "error");
  statusEl.classList.toggle("done", status.state === "done");
  statusEl.textContent = status.message;

  const busy = ["collecting", "thinking", "filling"].includes(status.state);
  fillBtn.disabled = busy;

  if (status.state === "done" && status.unanswered?.length) {
    unansweredEl.classList.remove("hidden");
    unansweredEl.innerHTML = "<strong>Needs your attention:</strong>";
    for (const label of status.unanswered) {
      const li = document.createElement("li");
      li.textContent = label;
      unansweredEl.appendChild(li);
    }
  } else {
    unansweredEl.classList.add("hidden");
  }
}

async function init() {
  const { profile, settings } = await chrome.storage.local.get(["profile", "settings"]);
  renderReadiness(profile, settings);

  const { fillStatus } = await chrome.storage.session.get("fillStatus");
  // Only show recent status (last 5 minutes) so stale results don't linger.
  if (fillStatus && Date.now() - fillStatus.at < 5 * 60 * 1000) {
    renderStatus(fillStatus);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.fillStatus) {
    renderStatus(changes.fillStatus.newValue);
  }
});

fillBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  renderStatus({ state: "collecting", message: "Starting…" });
  chrome.runtime.sendMessage({ type: "fill-page", tabId: tab.id });
});

init();
