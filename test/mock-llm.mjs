// DEV-ONLY mock LLM server. OpenAI-compatible /v1/chat/completions endpoint
// that answers AutoApplyer's two prompts deterministically:
//   - fill prompts: rule-based matching of field labels to the profile JSON
//   - extraction prompts: a canned profile parsed from nothing (fixed output)
// Point the extension at it with provider "custom", baseUrl http://localhost:8766/v1.
// Run standalone: node test/mock-llm.mjs
import http from "node:http";

export const EXTRACTED_PROFILE = {
  firstName: "Jordan",
  lastName: "Rivera",
  email: "jordan.rivera@example.edu",
  phone: "(404) 555-0142",
  street: "", city: "Atlanta", state: "Georgia", zip: "30301", country: "United States",
  linkedin: "https://linkedin.com/in/jordanrivera",
  github: "https://github.com/jordanrivera",
  portfolio: "",
  skills: "Python, JavaScript, SQL, React",
  summary: "CS junior at Georgia Tech focused on backend engineering.",
  education: [
    { school: "Georgia Institute of Technology", degree: "Bachelor of Science", field: "Computer Science", gpa: "3.8", start: "2023-08", end: "2027-05" },
  ],
  experience: [
    { company: "Acme Labs", title: "Software Engineering Intern", location: "Remote", start: "2025-05", end: "2025-08", current: false, description: "Built internal tooling in Python and React." },
  ],
};

function jsonBlockAfter(text, marker) {
  const i = text.indexOf(marker);
  if (i === -1) return null;
  const rel = text.slice(i).search(/[[{]/);
  if (rel === -1) return null;
  const open = i + rel;
  const openCh = text[open];
  const closeCh = openCh === "[" ? "]" : "}";
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === openCh) depth++;
    else if (text[j] === closeCh && --depth === 0) {
      return JSON.parse(text.slice(open, j + 1));
    }
  }
  return null;
}

function matchOption(field, wanted) {
  if (!field.options || !wanted) return wanted;
  const w = String(wanted).toLowerCase();
  const hit =
    field.options.find((o) => o.value.toLowerCase() === w) ||
    field.options.find((o) => o.text.toLowerCase() === w) ||
    field.options.find((o) => o.text && w.includes(o.text.toLowerCase())) ||
    field.options.find((o) => w && o.text.toLowerCase().includes(w));
  return hit ? hit.value : null;
}

function answerField(field, profile) {
  const hay = `${field.label || ""} ${field.name || ""} ${field.placeholder || ""}`.toLowerCase();
  const edu = profile.education?.[0] || {};
  const has = (re) => re.test(hay);

  if (field.type === "checkbox") {
    if (has(/certify|agree|accurate|terms/)) return true;
    return null;
  }
  let raw = null;
  if (has(/first\s*name/)) raw = profile.firstName;
  else if (has(/last\s*name|surname|family\s*name/)) raw = profile.lastName;
  else if (has(/e-?mail/)) raw = profile.email;
  else if (has(/phone/)) raw = profile.phone;
  else if (has(/authorized to work|work auth/)) raw = (profile.workAuthorized || "").toLowerCase();
  else if (has(/city/)) raw = profile.city;
  else if (has(/\bstate\b|province/)) raw = profile.state;
  else if (has(/country/)) raw = profile.country;
  else if (has(/linkedin/)) raw = profile.linkedin;
  else if (has(/github/)) raw = profile.github;
  else if (has(/school|university|college/)) raw = edu.school;
  else if (has(/degree/)) raw = edu.degree;
  else if (has(/major|field of study/)) raw = edu.field;
  else if (has(/gpa/)) raw = edu.gpa;
  else if (has(/graduation/)) raw = edu.end;
  else if (has(/sponsorship|visa/)) raw = (profile.needsSponsorship || "").toLowerCase();
  else if (has(/start\s*date|available/)) raw = profile.startDate;
  else if (has(/why|cover|tell us/)) {
    raw = profile.summary ? `I'm excited to apply what I've built as ${profile.summary}` : null;
  } else if (has(/skills/)) raw = profile.skills;
  if (raw == null || raw === "") return null;
  return field.options ? matchOption(field, raw) : raw;
}

function handleFill(userText) {
  const profile = jsonBlockAfter(userText, "Applicant profile:") || {};
  const fields = jsonBlockAfter(userText, "Form fields:") || [];
  const fills = [];
  const unanswered = [];
  for (const f of fields) {
    const v = answerField(f, profile);
    if (v === null || v === undefined) unanswered.push({ id: f.id, reason: "no match in mock" });
    else fills.push({ id: f.id, value: v });
  }
  return { fills, unanswered };
}

function collectText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p?.type === "text" ? p.text : "")).join("\n");
  }
  return "";
}

export function startMockLLM(port = 8766) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        const system = collectText(payload.messages?.find((m) => m.role === "system")?.content || "");
        const user = collectText(payload.messages?.find((m) => m.role === "user")?.content || "");
        const isExtract = /extract structured data from a resume/i.test(system);
        const out = isExtract ? EXTRACTED_PROFILE : handleFill(user);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "mock",
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(out) }, finish_reason: "stop" }],
          })
        );
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockLLM().then(() => console.log("Mock LLM listening on http://localhost:8766/v1"));
}
