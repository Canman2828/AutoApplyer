# AutoApplyer

A Chrome extension that fills out internship/job applications for you. You save your common application info once, plug in an API key for the AI model of your choice, and click **Fill this page** on any application form — the model matches your saved info to the form's fields and fills them in.

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.

## Setup

1. Click the AutoApplyer icon → **⚙ Settings** (or right-click the icon → Options).
2. Fill out your profile: personal info, links, education, experience, skills, work eligibility, and answers to common essay questions ("Why do you want to work here?").
3. In the **AI Model** section, pick a provider and paste your API key:
   - **Anthropic (Claude)** — default model is `claude-opus-4-8`; get a key at [platform.claude.com](https://platform.claude.com).
   - **OpenAI** — enter any OpenAI model name.
   - **Custom (OpenAI-compatible)** — enter a base URL (e.g. `https://openrouter.ai/api/v1`, or `http://localhost:11434/v1` for Ollama) plus a model name. This lets you use essentially any model.
4. (Optional) **Workday Sign-in** — Workday requires an account before you can apply. Enable this section and enter a Workday email/password, and when "Fill this page" runs on a Workday sign-in or create-account page it fills the credentials for you (and can optionally click the submit button too). Credentials are filled deterministically — they are **never sent to the AI model** — and only on real Workday domains (`myworkday.com` / `myworkdayjobs.com`). The password is stored unencrypted in extension storage, so use a unique password. After signing in, click **Fill this page** again on the application itself.
5. Click **Save**.

## Use

1. Open an internship application page.
2. Click the AutoApplyer icon → **Fill this page**.
3. The extension scans the form (including embedded iframes like Greenhouse), sends the fields + your profile to your chosen model, and fills in the answers. Selects, radios, and checkboxes are matched to their real options; React-based forms are supported.
4. The popup lists anything the model couldn't answer from your profile, and file uploads (resume/transcript) are flagged for you to do manually.
5. **Review everything before you submit** — the extension never submits the form for you.

## Privacy notes

- Your profile and API key are stored locally in `chrome.storage` in your browser — nothing is sent anywhere except to the AI provider you configured, and only when you click **Fill this page**.
- The model is instructed to only use information from your profile and never invent facts. Demographic/EEO questions are left as "prefer not to say" unless you explicitly filled them in.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker — orchestrates scan → LLM call → fill; talks to the provider APIs |
| `content.js` | Injected into pages — collects form fields, applies answers, shows a toast |
| `popup/` | Toolbar popup — readiness checks, Fill button, status/results |
| `options/` | Settings page — profile editor + AI provider settings |
