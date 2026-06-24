import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { paths } from "../paths.js";
import { clipVisibleText, type WorkbenchPageSnapshot, type WorkbenchStepResult } from "./render.js";
import {
  assessHumanHandoff,
  type WorkbenchApproval,
  type WorkbenchStep,
  assertReadOnlyWorkbenchAction,
  validateWorkbenchSteps,
  validateWorkbenchUrl,
} from "./safety.js";

export interface OpenUrlOptions {
  timeoutMs?: number;
  now?: Date;
}

export interface RunStepsOptions extends OpenUrlOptions {
  request?: string;
  approval?: WorkbenchApproval;
  /** Test/smoke-only escape hatch for deterministic local fixture pages. Not exposed via the agent tool. */
  fixtureHtml?: string;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function ensureWorkbenchDirs(): Promise<void> {
  await Promise.all([
    mkdir(paths.workbenchProfile, { recursive: true }),
    mkdir(paths.workbenchDownloads, { recursive: true }),
    mkdir(paths.workbenchScreenshots, { recursive: true }),
    mkdir(paths.workbenchArtifacts, { recursive: true }),
  ]);
}

async function assertNoHumanHandoffSignals(page: Page): Promise<void> {
  const signals = await page
    .evaluate(() => {
      const doc = (
        globalThis as unknown as {
          document?: { body?: { innerText?: string }; querySelector: (selector: string) => unknown };
        }
      ).document;
      const password =
        doc?.querySelector('input[type="password"]') !== undefined &&
        doc?.querySelector('input[type="password"]') !== null;
      const text = doc?.body?.innerText ?? "";
      const captcha = /\b(captcha|recaptcha|hcaptcha|human verification)\b/i.test(text);
      const twoFactor = /\b(two[- ]factor|2fa|mfa|verification code|one[- ]time code)\b/i.test(text);
      return { password, captcha, twoFactor };
    })
    .catch(() => ({ password: false, captcha: false, twoFactor: false }));

  if (signals.password || signals.captcha || signals.twoFactor) {
    throw new Error("Human handoff required: password/2FA/CAPTCHA-like page detected. Workbench will not bypass it.");
  }
}

async function assertPublicHttpUrl(url: string): Promise<void> {
  if (url === "about:blank" || url.startsWith("about:blank#")) return;
  const validation = validateWorkbenchUrl(url);
  if (!validation.allowed)
    throw new Error(`Navigation blocked after action: ${validation.reason ?? "URL is not allowed."}`);
}

function locatorForStep(page: Page, step: WorkbenchStep): Locator {
  if (step.selector) return page.locator(step.selector).first();
  if (step.action === "type" || step.action === "fill") return page.getByLabel(step.text ?? "").first();
  return page.getByText(step.text ?? "", { exact: false }).first();
}

async function snapshotPage(
  page: Page,
  input: {
    requestedUrl: string;
    capturedAtDate: Date;
    screenshotPath: string;
    artifactPath: string;
    steps?: WorkbenchStepResult[];
  },
): Promise<WorkbenchPageSnapshot> {
  await assertPublicHttpUrl(page.url());
  await assertNoHumanHandoffSignals(page);

  const title = await page.title();
  const rawText = await page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "");
  const visibleText = clipVisibleText(rawText).text;
  await page.screenshot({ path: input.screenshotPath, fullPage: true });

  const snapshot: WorkbenchPageSnapshot = {
    requestedUrl: input.requestedUrl,
    finalUrl: page.url(),
    title,
    visibleText,
    screenshotPath: input.screenshotPath,
    artifactPath: input.artifactPath,
    capturedAt: input.capturedAtDate.toISOString(),
    steps: input.steps,
  };
  await writeFile(input.artifactPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  return snapshot;
}

export async function openUrlInWorkbench(
  inputUrl: string,
  options: OpenUrlOptions = {},
): Promise<WorkbenchPageSnapshot> {
  const action = assertReadOnlyWorkbenchAction("open_url");
  if (!action.allowed) throw new Error(action.reason);

  const validation = validateWorkbenchUrl(inputUrl);
  if (!validation.allowed || !validation.url) throw new Error(validation.reason ?? "URL is not allowed.");

  return runStepsInWorkbench([{ action: "open_url", url: validation.url.toString() }], options);
}

export async function runStepsInWorkbench(
  steps: WorkbenchStep[],
  options: RunStepsOptions = {},
): Promise<WorkbenchPageSnapshot> {
  const validation = validateWorkbenchSteps(steps, {
    request: options.request,
    approval: options.approval,
    allowNoOpen: Boolean(options.fixtureHtml),
  });
  if (!validation.allowed) throw new Error(validation.reason ?? "Workbench steps are not allowed.");

  const requestHandoff = assessHumanHandoff(options.request ?? "");
  if (requestHandoff.approvalRequired) throw new Error(requestHandoff.reason ?? "Human handoff required.");

  await ensureWorkbenchDirs();
  const capturedAtDate = options.now ?? new Date();
  const id = stamp(capturedAtDate);
  const screenshotPath = join(paths.workbenchScreenshots, `${id}.png`);
  const artifactPath = join(paths.workbenchArtifacts, `${id}.json`);

  const context = await chromium.launchPersistentContext(paths.workbenchProfile, {
    acceptDownloads: true,
    downloadsPath: paths.workbenchDownloads,
    headless: true,
    viewport: { width: 1365, height: 768 },
  });

  const results: WorkbenchStepResult[] = [];
  let requestedUrl = options.fixtureHtml
    ? "fixture://workbench-smoke"
    : (steps.find((step) => step.action === "open_url")?.url ?? "");

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    if (options.fixtureHtml) {
      await page.setContent(options.fixtureHtml, {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs ?? 30_000,
      });
      await assertNoHumanHandoffSignals(page);
    }

    for (const [index, step] of steps.entries()) {
      const startedUrl = page.url();
      if (step.action === "open_url") {
        const url = validateWorkbenchUrl(step.url ?? "");
        if (!url.allowed || !url.url) throw new Error(`Step ${index + 1}: ${url.reason ?? "URL is not allowed."}`);
        requestedUrl = url.url.toString();
        await page.goto(url.url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 30_000,
        });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      } else if (step.action === "click" || step.action === "submit") {
        await assertNoHumanHandoffSignals(page);
        await locatorForStep(page, step).click({ timeout: options.timeoutMs ?? 10_000 });
        await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
      } else if (step.action === "type") {
        await assertNoHumanHandoffSignals(page);
        const locator = locatorForStep(page, step);
        await assertLocatorIsSafeTextInput(locator);
        await locator.pressSequentially(step.value ?? "", { timeout: options.timeoutMs ?? 10_000 });
      } else if (step.action === "fill") {
        await assertNoHumanHandoffSignals(page);
        const locator = locatorForStep(page, step);
        await assertLocatorIsSafeTextInput(locator);
        await locator.fill(step.value ?? "", { timeout: options.timeoutMs ?? 10_000 });
      }

      await assertPublicHttpUrl(page.url());
      await assertNoHumanHandoffSignals(page);
      results.push({
        index: index + 1,
        action: step.action,
        target: step.selector ?? step.text ?? step.url ?? "(unknown)",
        startedUrl,
        endedUrl: page.url(),
      });
    }

    return await snapshotPage(page, { requestedUrl, capturedAtDate, screenshotPath, artifactPath, steps: results });
  } finally {
    await context.close();
  }
}

async function assertLocatorIsSafeTextInput(locator: Locator): Promise<void> {
  const safe = await locator.evaluate((element) => {
    const node = element as unknown as {
      tagName?: string;
      type?: string;
      name?: string;
      autocomplete?: string;
      isContentEditable?: boolean;
      getAttribute: (name: string) => string | null;
    };
    const tagName = node.tagName?.toLowerCase() ?? "";
    const type = node.type?.toLowerCase() ?? "";
    const name = node.name?.toLowerCase() ?? "";
    const autocomplete = node.autocomplete?.toLowerCase() ?? "";
    const label = [
      node.getAttribute("aria-label"),
      node.getAttribute("placeholder"),
      node.getAttribute("id"),
      name,
      autocomplete,
    ]
      .filter(Boolean)
      .join(" ");
    const sensitive =
      /password|passcode|otp|2fa|mfa|captcha|verification|credit.?card|card.?number|cvv|cvc|ssn|social.?security|secret|token|api.?key/.test(
        `${type} ${label}`,
      );
    const textyInput = tagName === "input" && ["", "text", "search", "email", "url", "tel"].includes(type);
    const textarea = tagName === "textarea";
    const editable = Boolean(node.isContentEditable);
    return (textyInput || textarea || editable) && !sensitive;
  });

  if (!safe) throw new Error("Refusing to type/fill: target is not a safe generic text field.");
}
