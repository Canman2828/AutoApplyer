// AutoApplyer background service worker.
// Orchestrates the fill flow: inject content script into every frame,
// collect form fields, send them + the saved profile to the configured
// LLM, then apply the returned answers back into the page.

const SYSTEM_PROMPT = `You fill out internship and job application forms on behalf of an applicant.
You are given the applicant's saved profile (JSON) and a list of form fields found on the page.

Rules:
- Only use information from the profile. NEVER invent facts (GPA, dates, phone numbers, IDs, references, salary history, visa status, demographics).
- For select/radio fields, "value" MUST exactly match one of the listed option values (prefer "value" over "text").
- For checkboxes, return true or false.
- For date fields, match the format hinted by the field's type or placeholder (e.g. MM/DD/YYYY, YYYY-MM-DD).
- Demographic / EEO questions (gender, race, veteran, disability): only answer if the profile explicitly contains that information; otherwise pick a "prefer not to say" style option if one exists, or leave it unanswered.
- Open-ended questions ("Why do you want to work here?", "Tell us about a project"): write a concise, specific answer grounded in the profile's experience, skills, and custom Q&A entries. If the profile gives you nothing relevant, leave it unanswered rather than writing generic filler.
- If a field is already filled with a plausible value, you may skip it.
- If the profile has no answer for a field, put it in "unanswered" with a short reason.

Respond with ONLY a JSON object, no prose, in this shape:
{"fills": [{"id": "q0", "value": "..."}], "unanswered": [{"id": "q3", "reason": "..."}]}`;

const EXTRACT_SYSTEM_PROMPT = `You extract structured data from a resume so it can pre-fill a job-application profile.
Only include information that is actually in the resume — never guess or invent. Use "" for missing string fields and omit list entries you can't support. Dates must be formatted YYYY-MM.

Respond with ONLY a JSON object, no prose, in this shape:
{
  "firstName": "", "lastName": "", "email": "", "phone": "",
  "street": "", "city": "", "state": "", "zip": "", "country": "",
  "linkedin": "", "github": "", "portfolio": "",
  "skills": "comma-separated list of skills",
  "summary": "1-3 sentence professional summary grounded in the resume",
  "education": [{"school": "", "degree": "", "field": "", "gpa": "", "start": "", "end": ""}],
  "experience": [{"company": "", "title": "", "location": "", "start": "", "end": "", "current": false, "description": ""}]
}`;

// MV3 service workers can be killed ~30s after the last event; a long LLM
// call must keep the worker alive until it resolves.
function withKeepAlive(promise) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20 * 1000);
  return promise.finally(() => clearInterval(timer));
}

// ---------- status ----------

async function setStatus(status) {
  await chrome.storage.session.set({ fillStatus: { ...status, at: Date.now() } });
}

// ---------- LLM providers ----------

function extractJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model did not return JSON.");
  return JSON.parse(t.slice(start, end + 1));
}

// userPrompt is a string; resume (optional) is the stored resume object
// ({ name, mime, base64, text }) and is sent as a document attachment (PDF)
// or inline text depending on provider support.
async function callAnthropic(settings, systemPrompt, userPrompt, resume) {
  const content = [];
  if (resume) {
    if (resume.mime === "application/pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: resume.base64 },
      });
    } else if (resume.text) {
      content.push({ type: "text", text: `Applicant's resume (${resume.name}):\n\n${resume.text}` });
    }
  }
  content.push({ type: "text", text: userPrompt });

  const headers = {
    "content-type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  // Identity-linked API keys must name the workspace the request acts in.
  if (settings.workspaceId) headers["anthropic-workspace-id"] = settings.workspaceId;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.model || "claude-opus-4-8",
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Anthropic API error (${res.status}): ${data?.error?.message || res.statusText}`);
  }
  if (data.stop_reason === "refusal") {
    throw new Error("The model declined this request.");
  }
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function callOpenAICompatible(settings, systemPrompt, userPrompt, resume) {
  const base = (settings.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const parts = [];
  if (resume) {
    if (resume.mime === "application/pdf") {
      // OpenAI-style file part; endpoints that don't support it will error,
      // in which case the user can save a .txt resume instead.
      parts.push({
        type: "file",
        file: { filename: resume.name, file_data: `data:application/pdf;base64,${resume.base64}` },
      });
    } else if (resume.text) {
      parts.push({ type: "text", text: `Applicant's resume (${resume.name}):\n\n${resume.text}` });
    }
  }
  parts.push({ type: "text", text: userPrompt });

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: "system", content: systemPrompt },
        // Plain string when there's no attachment — maximally compatible.
        { role: "user", content: parts.length === 1 ? userPrompt : parts },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`API error (${res.status}): ${data?.error?.message || res.statusText}`);
  }
  return data?.choices?.[0]?.message?.content || "";
}

async function callLLM(settings, systemPrompt, userPrompt, resume) {
  const call =
    settings.provider === "anthropic"
      ? callAnthropic(settings, systemPrompt, userPrompt, resume)
      : callOpenAICompatible(settings, systemPrompt, userPrompt, resume);
  return withKeepAlive(call);
}

// ---------- prompt ----------

function buildUserPrompt(profile, page, fields, hasResume) {
  return [
    `Page: ${page.title}`,
    `URL: ${page.url}`,
    "",
    hasResume
      ? "The applicant's resume is included above — treat it as part of the profile when answering.\n"
      : "",
    "Applicant profile:",
    JSON.stringify(profile, null, 2),
    "",
    "Form fields:",
    JSON.stringify(fields, null, 2),
  ].join("\n");
}

// ---------- resume → profile extraction ----------

async function extractProfileFromResume(settings) {
  const { resume } = await chrome.storage.local.get("resume");
  if (!resume?.base64) {
    throw new Error("No resume saved. Upload one first.");
  }
  if (!settings?.apiKey) {
    throw new Error("Add an API key in the AI Model section first.");
  }
  if (settings.provider !== "anthropic" && !settings.model) {
    throw new Error("Enter a model name in the AI Model section first.");
  }
  if (resume.mime !== "application/pdf" && !resume.text) {
    throw new Error("Saved resume has no readable text. Upload a PDF or .txt file.");
  }
  const raw = await callLLM(
    settings,
    EXTRACT_SYSTEM_PROMPT,
    "Extract the applicant profile from the resume above.",
    resume
  );
  const profile = extractJson(raw);
  if (!profile || typeof profile !== "object") {
    throw new Error("Model did not return a profile.");
  }
  return profile;
}

// ---------- fill flow ----------

// Workday gates applications behind a sign-in / create-account page. This is
// handled deterministically — the password is read from local storage and
// filled directly by the content script; it is NEVER sent to the LLM.
async function handleWorkdaySignIn(tabId, probe, settings) {
  const wd = settings?.workday || {};
  if (!wd.enabled || !wd.email || !wd.password) {
    throw new Error(
      'This looks like a Workday sign-in page. Add your Workday email and password in AutoApplyer settings ("Workday Sign-in"), or sign in manually, then run Fill again.'
    );
  }

  await setStatus({ state: "filling", message: "Filling Workday sign-in…" });
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [probe.frameId] },
    func: (creds) => window.__AAF__.fillAuth(creds),
    args: [{ email: wd.email, password: wd.password, autoSubmit: !!wd.autoSubmit }],
  });

  const res = r?.result || { filled: [] };
  const what = res.mode === "create" ? "account-creation" : "sign-in";
  let message;
  if (!res.filled.length) {
    message = "Found a Workday sign-in page but could not fill it — sign in manually.";
  } else if (res.submitted) {
    message = `Workday ${what} form filled and submitted. Once signed in, open the application and click Fill again.`;
  } else {
    message = `Workday ${what} form filled (${res.filled.join(", ")}). Click the submit button, then run Fill again on the application.`;
  }

  await setStatus({ state: "done", message });
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [probe.frameId] },
    func: (msg) => window.__AAF__.toast(msg),
    args: [`AutoApplyer: ${message}`],
  });
}

async function runFill(tabId) {
  try {
    await setStatus({ state: "collecting", message: "Scanning form fields…" });

    const { profile, settings } = await chrome.storage.local.get(["profile", "settings"]);

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });

    // Workday sign-in page? Handle it without the LLM and stop there.
    const probes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (window.__AAF__ ? window.__AAF__.authProbe() : null),
    });
    const authFrame = probes.find((p) => p?.result?.isWorkday && p.result.hasPassword);
    if (authFrame) {
      await handleWorkdaySignIn(tabId, authFrame, settings);
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (window.__AAF__ ? window.__AAF__.collect() : null),
    });

    // Merge fields across frames, namespacing ids by frameId.
    const allFields = [];
    const idMap = new Map(); // globalId -> { frameId, localId }
    const fileFields = []; // { frameId, localId, label, name }
    let page = { title: "", url: "" };
    for (const r of results) {
      if (!r?.result) continue;
      if (r.frameId === 0) page = { title: r.result.title, url: r.result.url };
      for (const ff of r.result.fileFields || []) {
        fileFields.push({ frameId: r.frameId, localId: ff.id, label: ff.label, name: ff.name });
      }
      for (const f of r.result.fields) {
        const globalId = `f${r.frameId}_${f.id}`;
        idMap.set(globalId, { frameId: r.frameId, localId: f.id });
        allFields.push({ ...f, id: globalId });
      }
    }

    if (!allFields.length && !fileFields.length) {
      throw new Error("No form fields found on this page.");
    }

    // Attach the saved resume to any Resume/CV upload fields — done locally,
    // before/without the LLM.
    const { resume } = await chrome.storage.local.get("resume");
    const attachedTo = [];
    const manualFiles = [];
    const RESUME_RE = /resume|\bcv\b|curriculum/i;
    for (const ff of fileFields) {
      if (resume?.base64 && RESUME_RE.test(`${ff.label} ${ff.name}`)) {
        try {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [ff.frameId] },
            func: (items) => window.__AAF__.attachFiles(items),
            args: [[{ id: ff.localId, name: resume.name, mime: resume.mime, base64: resume.base64 }]],
          });
          if (r?.result?.attached?.length) {
            attachedTo.push(ff.label || ff.name || "resume upload");
            continue;
          }
        } catch {
          // fall through to manual
        }
      }
      manualFiles.push(ff.label || ff.name || "file upload");
    }

    if (!allFields.length) {
      const message = attachedTo.length
        ? `Attached your resume to: ${attachedTo.join(", ")}. No other fillable fields found.`
        : "No form fields found on this page.";
      await setStatus({ state: "done", message });
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: (msg) => window.__AAF__.toast(msg),
        args: [`AutoApplyer: ${message}`],
      });
      return;
    }

    if (!settings?.apiKey) {
      throw new Error("No API key set. Open AutoApplyer settings and add one.");
    }
    if (settings.provider !== "anthropic" && !settings.model) {
      throw new Error("No model set. Open AutoApplyer settings and enter a model name.");
    }
    if (!profile || !profile.firstName) {
      throw new Error("Profile is empty. Open AutoApplyer settings and fill in your information.");
    }

    await setStatus({
      state: "thinking",
      message: `Asking ${settings.model || "the model"} to answer ${allFields.length} fields…`,
    });

    const raw = await callLLM(settings, SYSTEM_PROMPT, buildUserPrompt(profile, page, allFields, !!resume?.base64), resume);
    const plan = extractJson(raw);
    const fills = Array.isArray(plan.fills) ? plan.fills : [];
    const unanswered = Array.isArray(plan.unanswered) ? plan.unanswered : [];

    await setStatus({ state: "filling", message: "Filling in the form…" });

    // Group fills per frame and apply.
    const byFrame = new Map();
    for (const fill of fills) {
      const loc = idMap.get(fill.id);
      if (!loc) continue;
      if (!byFrame.has(loc.frameId)) byFrame.set(loc.frameId, []);
      byFrame.get(loc.frameId).push({ id: loc.localId, value: fill.value });
    }

    let filled = 0;
    let failed = 0;
    for (const [frameId, frameFills] of byFrame) {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (fs) => window.__AAF__.apply(fs),
        args: [frameFills],
      });
      if (r?.result) {
        filled += r.result.filled;
        failed += r.result.failed.length;
      }
    }

    const labelById = new Map(allFields.map((f) => [f.id, f.label || f.name || f.placeholder || f.id]));
    const unansweredLabels = unanswered.map((u) => labelById.get(u.id) || u.id);

    let message = `Filled ${filled} of ${allFields.length} fields.`;
    if (failed) message += ` ${failed} could not be matched.`;
    if (attachedTo.length) message += ` Resume attached to: ${attachedTo.join(", ")}.`;
    if (manualFiles.length) message += ` File uploads need manual attention: ${manualFiles.join(", ")}.`;

    await setStatus({
      state: "done",
      message,
      unanswered: unansweredLabels,
    });

    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (msg) => window.__AAF__.toast(msg),
      args: [`AutoApplyer: ${message} Review before submitting.`],
    });
  } catch (err) {
    const message = err.message || String(err);
    await setStatus({ state: "error", message });
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: (msg) => window.__AAF__ && window.__AAF__.toast(msg),
        args: [`AutoApplyer error: ${message}`],
      });
    } catch {
      // page may not allow injection; the popup still shows the error
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "fill-page") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (tabId) runFill(tabId);
    sendResponse({ started: !!tabId });
  } else if (msg?.type === "extract-profile") {
    // From the options page: parse the saved resume into a profile draft.
    extractProfileFromResume(msg.settings)
      .then((profile) => sendResponse({ ok: true, profile }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  } else if (msg?.type === "seed-profile" && msg.payload) {
    // Dev helper (used by the localhost test bridge): overwrite the saved
    // profile. Never touches settings/API key.
    chrome.storage.local.set({ profile: msg.payload }).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg?.type === "seed-settings" && msg.payload) {
    // Dev helper (localhost test bridge): overwrite settings so the test
    // harness can point the extension at a mock LLM endpoint.
    chrome.storage.local.set({ settings: msg.payload }).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg?.type === "seed-resume" && msg.payload) {
    // Dev helper (localhost test bridge): store a resume for attach tests.
    chrome.storage.local.set({ resume: msg.payload }).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg?.type === "get-status") {
    chrome.storage.session.get("fillStatus").then((r) => sendResponse(r.fillStatus || null));
    return true;
  }
  return false;
});
