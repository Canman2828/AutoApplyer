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
  document.getElementById("workspaceRow").classList.toggle("hidden", p !== "anthropic");
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

// ---------- resume ----------

const resumeFileEl = document.getElementById("resumeFile");
const autofillBtn = document.getElementById("autofillBtn");
const autofillStatus = document.getElementById("autofillStatus");
const MAX_RESUME_BYTES = 8 * 1024 * 1024;

function renderResume(resume) {
  const has = !!resume?.base64;
  document.getElementById("resumeEmpty").classList.toggle("hidden", has);
  document.getElementById("resumeInfo").classList.toggle("hidden", !has);
  autofillBtn.disabled = !has;
  if (has) {
    document.getElementById("resumeName").textContent = resume.name;
    document.getElementById("resumeSize").textContent = `(${Math.max(1, Math.round(resume.size / 1024))} KB)`;
  }
}

function readFile(file, as) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    if (as === "text") r.readAsText(file);
    else r.readAsDataURL(file);
  });
}

function setAutofillStatus(text, cls = "") {
  autofillStatus.textContent = text;
  autofillStatus.className = `autofill-status ${cls}`;
}

resumeFileEl.addEventListener("change", async () => {
  const file = resumeFileEl.files?.[0];
  if (!file) return;
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isText = /^text\//.test(file.type) || /\.(txt|md)$/i.test(file.name);
  if (!isPdf && !isText) {
    setAutofillStatus("Please choose a PDF or plain-text (.txt/.md) file.", "error");
    resumeFileEl.value = "";
    return;
  }
  if (file.size > MAX_RESUME_BYTES) {
    setAutofillStatus("File is too large (max 8 MB).", "error");
    resumeFileEl.value = "";
    return;
  }
  const dataUrl = await readFile(file, "dataUrl");
  const resume = {
    name: file.name,
    mime: isPdf ? "application/pdf" : "text/plain",
    size: file.size,
    base64: String(dataUrl).split(",")[1] || "",
    text: isText ? await readFile(file, "text") : "",
    savedAt: Date.now(),
  };
  await chrome.storage.local.set({ resume });
  renderResume(resume);
  setAutofillStatus("Resume saved ✓", "ok");
  resumeFileEl.value = "";
});

document.getElementById("resumeReplace").addEventListener("click", () => resumeFileEl.click());
document.getElementById("resumeRemove").addEventListener("click", async () => {
  await chrome.storage.local.remove("resume");
  renderResume(null);
  setAutofillStatus("");
});

function applyExtractedProfile(profile) {
  for (const key of SIMPLE_FIELDS) {
    const val = profile[key];
    if (typeof val !== "string" || !val.trim()) continue;
    const el = document.querySelector(`[name="${key}"]`);
    if (el) el.value = val.trim();
  }
  for (const kind of ["education", "experience"]) {
    const entries = Array.isArray(profile[kind]) ? profile[kind].filter((e) => e && typeof e === "object") : [];
    if (!entries.length) continue;
    const list = document.getElementById(REPEATS[kind].listId);
    // Replace only empty placeholder rows; keep anything the user typed.
    for (const item of list.querySelectorAll(".repeat-item")) {
      const hasValue = [...item.querySelectorAll("input, textarea")].some((i) =>
        i.type === "checkbox" ? i.checked : i.value.trim()
      );
      if (!hasValue) item.remove();
    }
    entries.forEach((e) => addRepeatItem(kind, e));
  }
}

autofillBtn.addEventListener("click", async () => {
  const settings = {
    provider: providerEl.value,
    apiKey: document.getElementById("apiKey").value.trim(),
    model: modelEl.value.trim(),
    baseUrl: document.getElementById("baseUrl").value.trim(),
    workspaceId: document.getElementById("workspaceId").value.trim(),
  };
  autofillBtn.disabled = true;
  setAutofillStatus("Reading your resume with the AI model…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "extract-profile", settings });
    if (!res?.ok) throw new Error(res?.error || "Extraction failed.");
    applyExtractedProfile(res.profile);
    setAutofillStatus("Profile filled from resume — review it, then click Save.", "ok");
  } catch (err) {
    setAutofillStatus(err.message || String(err), "error");
  } finally {
    autofillBtn.disabled = false;
  }
});

// ---------- load / save ----------

async function load() {
  const { profile = {}, settings = {}, resume = null } = await chrome.storage.local.get([
    "profile",
    "settings",
    "resume",
  ]);
  renderResume(resume);

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
  document.getElementById("workspaceId").value = settings.workspaceId || "";

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
    workspaceId: document.getElementById("workspaceId").value.trim(),
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
