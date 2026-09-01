// End-to-end test: loads the extension into Chrome (headless), serves the
// sample application page, points the extension at the mock LLM server, runs
// the full fill flow, and asserts on the resulting form values — including
// resume auto-attach and resume → profile extraction on the options page.
//
//   cd test && npm install && node e2e.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { startMockLLM, EXTRACTED_PROFILE } from "./mock-llm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const RESUME_TEXT = `Jordan Rivera
Atlanta, GA · jordan.rivera@example.edu · (404) 555-0142
github.com/jordanrivera · linkedin.com/in/jordanrivera

EDUCATION
Georgia Institute of Technology — B.S. Computer Science, GPA 3.8, Aug 2023 – May 2027

EXPERIENCE
Acme Labs — Software Engineering Intern (May 2025 – Aug 2025)
Built internal tooling in Python and React.

SKILLS: Python, JavaScript, SQL, React`;

const PROFILE = {
  ...EXTRACTED_PROFILE,
  workAuthorized: "Yes",
  needsSponsorship: "No",
  over18: "Yes",
  startDate: "2027-06-01",
};

const SETTINGS = {
  provider: "custom",
  apiKey: "test-key",
  model: "mock-model",
  baseUrl: "http://localhost:8766/v1",
  workday: { enabled: false, email: "", password: "", autoSubmit: false },
};

// ---------- tiny static server for the test page ----------
function startStatic(port = 8765) {
  const server = http.createServer(async (req, res) => {
    const file = req.url === "/" ? "/application.html" : req.url.split("?")[0];
    try {
      const data = await readFile(path.join(__dirname, path.normalize(file)));
      res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "text/plain" });
      res.end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

// ---------- assertions ----------
let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = expected instanceof RegExp ? expected.test(String(actual)) : actual === expected;
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name} — expected ${expected}, got ${JSON.stringify(actual)}`);
  }
}

// Talk to the extension through the localhost test bridge.
async function bridge(page, type, payload) {
  return page.evaluate(
    ({ type, payload }) =>
      new Promise((resolve) => {
        const onMsg = (e) => {
          if (e.data?.aafTestResult && e.data.forType === type) {
            window.removeEventListener("message", onMsg);
            resolve(e.data.res);
          }
        };
        window.addEventListener("message", onMsg);
        window.postMessage({ aafTest: true, type, payload }, "*");
      }),
    { type, payload }
  );
}

async function waitForStatus(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await bridge(page, "get-status");
    if (status && ["done", "error"].includes(status.state)) return status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for fill status.");
}

const staticServer = await startStatic();
const mockServer = await startMockLLM();
console.log("Servers up: test page :8765, mock LLM :8766");

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  enableExtensions: true,
  args: ["--no-first-run", "--no-default-browser-check"],
});

try {
  const extId = await browser.installExtension(EXT_PATH);
  console.log(`Extension installed: ${extId}`);

  const page = await browser.newPage();
  await page.goto("http://localhost:8765/application.html", { waitUntil: "load" });
  await page.waitForFunction(() => document.documentElement.dataset.aafBridge === "ready", { timeout: 10000 });

  console.log("\n— Seeding profile, settings, resume —");
  check("seed-profile ok", (await bridge(page, "seed-profile", PROFILE))?.ok, true);
  check("seed-settings ok", (await bridge(page, "seed-settings", SETTINGS))?.ok, true);
  const resume = {
    name: "resume.txt",
    mime: "text/plain",
    size: RESUME_TEXT.length,
    base64: Buffer.from(RESUME_TEXT, "utf8").toString("base64"),
    text: RESUME_TEXT,
    savedAt: Date.now(),
  };
  check("seed-resume ok", (await bridge(page, "seed-resume", resume))?.ok, true);

  console.log("\n— Running fill flow —");
  await bridge(page, "fill-page");
  const status = await waitForStatus(page);
  console.log(`  status: [${status.state}] ${status.message}`);
  check("fill completed", status.state, "done");

  const val = (sel) => page.$eval(sel, (el) => el.value);
  check("first name", await val("#first"), "Jordan");
  check("last name", await val("#last"), "Rivera");
  check("email", await val("#email"), "jordan.rivera@example.edu");
  check("phone", await val("#phone"), "(404) 555-0142");
  check("city", await val("#city"), "Atlanta");
  check("state select", await val("#state"), "GA");
  check("country select", await val("#country"), "US");
  check("linkedin", await val("#linkedin"), PROFILE.linkedin);
  check("github", await val("#github"), PROFILE.github);
  check("school", await val("#school"), "Georgia Institute of Technology");
  check("degree select", await val("#degree"), "bs");
  check("major", await val("#major"), "Computer Science");
  check("gpa", await val("#gpa"), "3.8");
  check("graduation month", await val("#grad"), "2027-05");
  check("work auth radio", await page.$eval('input[name="work_auth"][value="yes"]', (el) => el.checked), true);
  check("sponsorship radio", await page.$eval('input[name="sponsorship"][value="no"]', (el) => el.checked), true);
  check("start date", await val("#start"), "2027-06-01");
  check("why essay filled", (await val("#why")).length > 10, true);
  check("skills", await val("#skillsIn"), PROFILE.skills);
  check("certify checkbox", await page.$eval("#agree", (el) => el.checked), true);
  check(
    "resume auto-attached",
    await page.$eval("#resume", (el) => (el.files.length === 1 ? el.files[0].name : "none")),
    "resume.txt"
  );
  check("status mentions resume attach", status.message, /Resume attached/);

  console.log("\n— Resume → profile extraction (options page) —");
  const opts = await browser.newPage();
  await opts.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: "load" });
  await opts.waitForFunction(() => !document.getElementById("autofillBtn").disabled, { timeout: 5000 });
  check("resume shown in settings", await opts.$eval("#resumeName", (el) => el.textContent), "resume.txt");
  await opts.click("#autofillBtn");
  await opts.waitForFunction(
    () => /review it|Save/.test(document.getElementById("autofillStatus").textContent) ||
          document.getElementById("autofillStatus").classList.contains("error"),
    { timeout: 30000 }
  );
  const st = await opts.$eval("#autofillStatus", (el) => ({ text: el.textContent, error: el.classList.contains("error") }));
  console.log(`  autofill status: ${st.text}`);
  check("extraction succeeded", st.error, false);
  check("extracted first name", await opts.$eval('[name="firstName"]', (el) => el.value), "Jordan");
  check("extracted city", await opts.$eval('[name="city"]', (el) => el.value), "Atlanta");
  check("extracted skills", await opts.$eval('[name="skills"]', (el) => el.value), EXTRACTED_PROFILE.skills);
  check(
    "extracted education school",
    await opts.$eval('#educationList [name="school"]', (el) => el.value),
    "Georgia Institute of Technology"
  );
  check(
    "extracted experience company",
    await opts.$eval('#experienceList [name="company"]', (el) => el.value),
    "Acme Labs"
  );

  // Save and confirm it persisted.
  await opts.click("#save");
  await new Promise((r) => setTimeout(r, 300));
  const savedProfile = await opts.evaluate(() => chrome.storage.local.get("profile").then((r) => r.profile));
  check("saved profile persists extraction", savedProfile.firstName, "Jordan");
} finally {
  await browser.close();
  staticServer.close();
  mockServer.close();
}

console.log(`\n${pass} passed, ${failures.length} failed${failures.length ? ": " + failures.join(", ") : ""}`);
process.exit(failures.length ? 1 : 0);
