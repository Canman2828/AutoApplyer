// AutoApplyer options page: loads/saves the profile and AI settings
// from chrome.storage.local.

const SIMPLE_FIELDS = [
  "firstName", "lastName", "email", "phone", "street", "city", "state", "zip", "country",
  "linkedin", "github", "portfolio",
  "skills", "summary",
  "workAuthorized", "needsSponsorship", "over18", "startDate", "desiredPay",
  "gender", "hispanic", "race", "veteran", "disability",
];

const REPEATS = {
  education: { listId: "educationList", tpl: "tpl-education" },
  experience: { listId: "experienceList", tpl: "tpl-experience" },
  custom: { listId: "customList", tpl: "tpl-custom" },
};

// ---------- repeatable sections ----------

function addRepeatItem(kind, data = {}) {
  const { listId, tpl } = REPEATS[kind];
  const list = document.getElementById(listId);
  const node = document.getElementById(tpl).content.cloneNode(true);
  const item = node.querySelector(".repeat-item");
  for (const input of item.querySelectorAll("input, textarea, select")) {
    const key = input.name;
    if (!(key in data)) continue;
    if (input.type === "checkbox") input.checked = !!data[key];
    else input.value = data[key] ?? "";
  }
  item.querySelector(".remove").addEventListener("click", () => item.remove());
  list.appendChild(node);
}

function readRepeatList(kind) {
  const { listId } = REPEATS[kind];
  const out = [];
  for (const item of document.getElementById(listId).querySelectorAll(".repeat-item")) {
    const entry = {};
    let hasValue = false;
    for (const input of item.querySelectorAll("input, textarea, select")) {
      const val = input.type === "checkbox" ? input.checked : input.value.trim();
      entry[input.name] = val;
      if (val && val !== false) hasValue = true;
    }
    if (hasValue) out.push(entry);
  }
  return out;
}

document.querySelectorAll(".add").forEach((btn) => {
  btn.addEventListener("click", () => addRepeatItem(btn.dataset.add));
});

// ---------- provider UI ----------

const providerEl = document.getElementById("provider");
const modelEl = document.getElementById("model");
const baseUrlRow = document.getElementById("baseUrlRow");

function updateProviderUI() {
  const p = providerEl.value;
  baseUrlRow.classList.toggle("hidden", p !== "custom");
  modelEl.placeholder =
    p === "anthropic" ? "claude-opus-4-8 (default)" :
    p === "openai" ? "e.g. gpt-4o" :
    "model name for your endpoint";
}
providerEl.addEventListener("change", updateProviderUI);

const wdEnabledEl = document.getElementById("wdEnabled");
function updateWorkdayUI() {
  document.getElementById("wdFields").classList.toggle("hidden", !wdEnabledEl.checked);
}
wdEnabledEl.addEventListener("change", updateWorkdayUI);

// ---------- load / save ----------

async function load() {
  const { profile = {}, settings = {} } = await chrome.storage.local.get(["profile", "settings"]);

  for (const key of SIMPLE_FIELDS) {
    const el = document.querySelector(`[name="${key}"]`);
    if (el) el.value = profile[key] ?? "";
  }

  for (const kind of Object.keys(REPEATS)) {
    const entries = Array.isArray(profile[kind]) ? profile[kind] : [];
    if (entries.length) entries.forEach((e) => addRepeatItem(kind, e));
    else addRepeatItem(kind);
  }

  providerEl.value = settings.provider || "anthropic";
  document.getElementById("apiKey").value = settings.apiKey || "";
  modelEl.value = settings.model || "";
  document.getElementById("baseUrl").value = settings.baseUrl || "";

  const wd = settings.workday || {};
  document.getElementById("wdEnabled").checked = !!wd.enabled;
  document.getElementById("wdEmail").value = wd.email || "";
  document.getElementById("wdPassword").value = wd.password || "";
  document.getElementById("wdAutoSubmit").checked = !!wd.autoSubmit;
  updateProviderUI();
  updateWorkdayUI();
}

async function save() {
  const profile = {};
  for (const key of SIMPLE_FIELDS) {
    const el = document.querySelector(`[name="${key}"]`);
    if (el) profile[key] = el.value.trim();
  }
  for (const kind of Object.keys(REPEATS)) {
    profile[kind] = readRepeatList(kind);
  }

  const settings = {
    provider: providerEl.value,
    apiKey: document.getElementById("apiKey").value.trim(),
    model: modelEl.value.trim(),
    baseUrl: document.getElementById("baseUrl").value.trim(),
    workday: {
      enabled: document.getElementById("wdEnabled").checked,
      email: document.getElementById("wdEmail").value.trim(),
      password: document.getElementById("wdPassword").value,
      autoSubmit: document.getElementById("wdAutoSubmit").checked,
    },
  };

  await chrome.storage.local.set({ profile, settings });

  const msg = document.getElementById("savedMsg");
  msg.classList.remove("hidden");
  setTimeout(() => msg.classList.add("hidden"), 2000);
}

document.getElementById("save").addEventListener("click", save);
load();
