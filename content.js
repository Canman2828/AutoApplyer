// AutoApplyer content script.
// Injected on demand into every frame of the active tab. Exposes
// window.__AAF__ = { collect, apply } which the background service worker
// drives via chrome.scripting.executeScript. Guarded so repeat injection
// is a no-op.
(() => {
  if (window.__AAF__) return;

  const MAX_FIELDS = 150;
  const MAX_OPTIONS = 300;
  const MAX_TEXT = 120;

  let fieldRegistry = new Map(); // localId -> element or radio group

  function trim(s) {
    if (!s) return "";
    return s.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  }

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function labelFor(el) {
    // <label for="...">
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && trim(lab.textContent)) return trim(lab.textContent);
    }
    // wrapping <label>
    const wrap = el.closest("label");
    if (wrap && trim(wrap.textContent)) return trim(wrap.textContent);
    // ARIA
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return trim(ariaLabel);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => trim(n.textContent))
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    // nearby text: previous sibling or parent's first text-ish node
    let node = el.parentElement;
    for (let depth = 0; node && depth < 3; depth++) {
      const candidates = node.querySelectorAll("label, legend, span, div, p");
      for (const c of candidates) {
        if (c.contains(el)) continue;
        const t = trim(c.textContent);
        if (t && t.length > 1 && t.length <= MAX_TEXT && c.querySelector("input,select,textarea") === null) {
          return t;
        }
      }
      node = node.parentElement;
    }
    return "";
  }

  // The question text for a radio group is usually NOT the per-option label
  // (that's "Yes"/"No"), but text just before the group's container.
  function radioGroupLabel(group) {
    let anc = group[0].parentElement;
    while (anc && !group.every((r) => anc.contains(r))) anc = anc.parentElement;
    for (let node = anc; node && node !== document.body; node = node.parentElement) {
      let sib = node.previousElementSibling;
      for (let hops = 0; sib && hops < 3; hops++) {
        if (!sib.querySelector("input, select, textarea")) {
          const t = trim(sib.textContent);
          if (t) return t;
        }
        sib = sib.previousElementSibling;
      }
    }
    const legend = group[0].closest("fieldset")?.querySelector("legend");
    return legend ? trim(legend.textContent) : "";
  }

  function selectOptions(el) {
    return Array.from(el.options)
      .slice(0, MAX_OPTIONS)
      .map((o) => ({ value: o.value, text: trim(o.textContent) }))
      .filter((o) => o.value !== "" || o.text !== "");
  }

  function collect() {
    fieldRegistry = new Map();
    const fields = [];
    const fileFields = [];
    let n = 0;
    const seenRadioGroups = new Set();

    const controls = document.querySelectorAll("input, select, textarea");
    for (const el of controls) {
      if (fields.length >= MAX_FIELDS) break;
      if (el.disabled || el.readOnly) continue;

      const tag = el.tagName.toLowerCase();
      const type = (el.type || "text").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image", "password"].includes(type)) continue;

      // File inputs are registered even when invisible — styled uploaders
      // (Greenhouse, Workday, dropzones) usually hide the real <input>.
      if (type === "file") {
        const id = `q${n++}`;
        const label = labelFor(el) || el.name || "file upload";
        fieldRegistry.set(id, { kind: "file", el, label });
        fileFields.push({ id, label, name: el.name || "", accept: el.accept || "" });
        continue;
      }

      if (!isVisible(el)) continue;

      const label = labelFor(el);

      if (type === "radio") {
        const groupKey = el.name || label;
        if (seenRadioGroups.has(groupKey)) continue;
        seenRadioGroups.add(groupKey);
        const group = Array.from(
          document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)
        ).filter(isVisible);
        if (!group.length) continue;
        const id = `q${n++}`;
        fieldRegistry.set(id, { kind: "radio", group });
        fields.push({
          id,
          tag: "radio-group",
          label: radioGroupLabel(group) || label || el.name,
          required: group.some((r) => r.required),
          value: (group.find((r) => r.checked) || {}).value || "",
          options: group.map((r) => ({ value: r.value, text: trim(labelFor(r)) || r.value })),
        });
        continue;
      }

      const id = `q${n++}`;
      fieldRegistry.set(id, { kind: tag === "select" ? "select" : type === "checkbox" ? "checkbox" : "text", el });

      const field = {
        id,
        tag,
        type,
        label,
        name: el.name || "",
        placeholder: el.placeholder || "",
        required: !!el.required,
        value: type === "checkbox" ? String(el.checked) : trim(el.value),
      };
      if (el.getAttribute("autocomplete")) field.autocomplete = el.getAttribute("autocomplete");
      if (tag === "select") field.options = selectOptions(el);
      fields.push(field);
    }

    return {
      url: location.href,
      title: document.title,
      fields,
      fileFields,
    };
  }

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function applyOne(entry, value) {
    if (entry.kind === "text") {
      setNativeValue(entry.el, String(value));
      return true;
    }
    if (entry.kind === "select") {
      const el = entry.el;
      const target = String(value).toLowerCase();
      const match =
        Array.from(el.options).find((o) => o.value === String(value)) ||
        Array.from(el.options).find((o) => o.value.toLowerCase() === target) ||
        Array.from(el.options).find((o) => o.textContent.trim().toLowerCase() === target);
      if (!match) return false;
      setNativeValue(el, match.value);
      return true;
    }
    if (entry.kind === "checkbox") {
      const want = value === true || String(value).toLowerCase() === "true" || String(value).toLowerCase() === "yes";
      if (entry.el.checked !== want) entry.el.click();
      return true;
    }
    if (entry.kind === "radio") {
      const target = String(value).toLowerCase();
      const match =
        entry.group.find((r) => r.value === String(value)) ||
        entry.group.find((r) => r.value.toLowerCase() === target) ||
        entry.group.find((r) => (labelFor(r) || "").toLowerCase() === target);
      if (!match) return false;
      if (!match.checked) match.click();
      return true;
    }
    return false;
  }

  function apply(fills) {
    let filled = 0;
    const failed = [];
    for (const { id, value } of fills) {
      const entry = fieldRegistry.get(id);
      if (!entry || value === null || value === undefined || value === "") continue;
      try {
        if (applyOne(entry, value)) filled++;
        else failed.push(id);
      } catch {
        failed.push(id);
      }
    }
    return { filled, failed };
  }

  // Attach stored files (e.g. the saved resume) to <input type="file"> fields
  // collected earlier. items: [{ id, name, mime, base64 }].
  function attachFiles(items) {
    const attached = [];
    const failed = [];
    for (const { id, name, mime, base64 } of items) {
      const entry = fieldRegistry.get(id);
      if (!entry || entry.kind !== "file") {
        failed.push(id);
        continue;
      }
      try {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], name, { type: mime });
        const dt = new DataTransfer();
        dt.items.add(file);
        entry.el.files = dt.files;
        entry.el.dispatchEvent(new Event("input", { bubbles: true }));
        entry.el.dispatchEvent(new Event("change", { bubbles: true }));
        attached.push(entry.label || name);
      } catch {
        failed.push(id);
      }
    }
    return { attached, failed };
  }

  // ---------- Workday sign-in ----------

  const WORKDAY_HOST = /(^|\.)myworkday(jobs)?\.com$/i;

  function isWorkdayHost() {
    return WORKDAY_HOST.test(location.hostname);
  }

  function findAuthElements() {
    const q = (sel) => {
      const el = document.querySelector(sel);
      return el && isVisible(el) ? el : null;
    };
    const email =
      q('input[data-automation-id="email"]') ||
      q('input[type="email"][autocomplete="username"]') ||
      q('input[type="email"]') ||
      q('input[type="text"][name*="email" i]');
    const verify = q('input[data-automation-id="verifyPassword"]');
    const password =
      q('input[data-automation-id="password"]') ||
      document.querySelector('input[type="password"]:not([data-automation-id="verifyPassword"])');
    const terms =
      q('input[data-automation-id="createAccountCheckbox"]') ||
      q('input[type="checkbox"][data-automation-id*="agree" i]');
    const submit =
      q('[data-automation-id="createAccountSubmitButton"]') ||
      q('[data-automation-id="signInSubmitButton"]') ||
      q('button[type="submit"]');
    return { email, password: password && isVisible(password) ? password : null, verify, terms, submit };
  }

  function authProbe() {
    const els = findAuthElements();
    return {
      isWorkday: isWorkdayHost(),
      hasEmail: !!els.email,
      hasPassword: !!els.password,
      mode: els.verify ? "create" : "signin",
    };
  }

  function fillAuth({ email, password, autoSubmit }) {
    const els = findAuthElements();
    const filled = [];
    if (els.email && email) {
      setNativeValue(els.email, email);
      filled.push("email");
    }
    if (els.password && password) {
      setNativeValue(els.password, password);
      filled.push("password");
    }
    if (els.verify && password) {
      setNativeValue(els.verify, password);
      filled.push("verify password");
    }
    if (els.terms && !els.terms.checked) {
      els.terms.click();
      filled.push("terms checkbox");
    }
    let submitted = false;
    if (autoSubmit && els.submit && filled.length) {
      els.submit.click();
      submitted = true;
    }
    return { filled, submitted, mode: els.verify ? "create" : "signin" };
  }

  function toast(message) {
    const existing = document.getElementById("__aaf_toast");
    if (existing) existing.remove();
    const div = document.createElement("div");
    div.id = "__aaf_toast";
    div.textContent = message;
    div.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#1f2430;color:#fff;" +
      "padding:12px 18px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);";
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 6000);
  }

  window.__AAF__ = { collect, apply, attachFiles, toast, authProbe, fillAuth };
})();
