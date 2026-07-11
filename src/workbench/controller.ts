import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type ElementHandle, type Locator, type Page } from "playwright";
import { atomicWriteFile } from "../lib/durable-file.js";
import { paths } from "../paths.js";
import { withWorkbenchLock } from "./lock.js";
import { clipVisibleText, type WorkbenchPageSnapshot, type WorkbenchStepResult } from "./render.js";
import { assessResolvedElement, type ResolvedElementSemantics } from "./dom-safety.js";
import { WorkbenchNetworkPolicy } from "./network-policy.js";
import {
  type WorkbenchStep,
  assertReadOnlyWorkbenchAction,
  validateWorkbenchSteps,
  validateWorkbenchUrl,
} from "./safety.js";

export interface OpenUrlOptions {
  timeoutMs?: number;
  now?: Date;
  signal?: AbortSignal;
}

export interface RunStepsOptions extends OpenUrlOptions {
  request?: string;
  capabilityGranted?: boolean;
  networkPolicy?: WorkbenchNetworkPolicy;
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
    signal?: AbortSignal;
  },
): Promise<WorkbenchPageSnapshot> {
  throwIfWorkbenchAborted(input.signal);
  await assertPublicHttpUrl(page.url());
  await assertNoHumanHandoffSignals(page);

  const title = await page.title();
  const rawText = await page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "");
  const visibleText = clipVisibleText(rawText).text;
  throwIfWorkbenchAborted(input.signal);
  await page.screenshot({ path: input.screenshotPath, fullPage: false, timeout: 10_000 });
  throwIfWorkbenchAborted(input.signal);

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
  await atomicWriteFile(input.artifactPath, `${JSON.stringify(snapshot, null, 2)}\n`);
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
    hasCapability: options.capabilityGranted,
    allowNoOpen: Boolean(options.fixtureHtml),
  });
  if (!validation.allowed) throw new Error(validation.reason ?? "Workbench steps are not allowed.");

  throwIfWorkbenchAborted(options.signal);
  return withWorkbenchLock(options.signal, () => runValidatedSteps(steps, options));
}

async function runValidatedSteps(steps: WorkbenchStep[], options: RunStepsOptions): Promise<WorkbenchPageSnapshot> {
  throwIfWorkbenchAborted(options.signal);

  await ensureWorkbenchDirs();
  const capturedAtDate = options.now ?? new Date();
  const id = stamp(capturedAtDate);
  const screenshotPath = join(paths.workbenchScreenshots, `${id}.png`);
  const artifactPath = join(paths.workbenchArtifacts, `${id}.json`);

  let context: BrowserContext | undefined;
  let closePromise: Promise<void> | undefined;
  const closeContext = (): Promise<void> => {
    if (!context) return Promise.resolve();
    closePromise ??= context.close().catch(() => undefined);
    return closePromise;
  };
  const onAbort = (): void => {
    // Closing the context is Playwright's cancellation primitive. It rejects
    // whichever navigation/click/type is in flight and terminates the browser.
    void closeContext();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const results: WorkbenchStepResult[] = [];
  let requestedUrl = options.fixtureHtml
    ? "fixture://workbench-smoke"
    : (steps.find((step) => step.action === "open_url")?.url ?? "");

  try {
    context = await chromium.launchPersistentContext(paths.workbenchProfile, {
      acceptDownloads: true,
      downloadsPath: paths.workbenchDownloads,
      headless: true,
      serviceWorkers: "block",
      viewport: { width: 1365, height: 768 },
      timeout: options.timeoutMs ?? 30_000,
    });
    throwIfWorkbenchAborted(options.signal);
    if (!options.fixtureHtml) await (options.networkPolicy ?? new WorkbenchNetworkPolicy()).install(context);
    const page = context.pages()[0] ?? (await context.newPage());
    if (options.fixtureHtml) {
      throwIfWorkbenchAborted(options.signal);
      await page.setContent(options.fixtureHtml, {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs ?? 30_000,
      });
      await assertNoHumanHandoffSignals(page);
    }

    for (const [index, step] of steps.entries()) {
      throwIfWorkbenchAborted(options.signal);
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
        const locator = locatorForStep(page, step);
        const element = await locator.elementHandle({ timeout: options.timeoutMs ?? 10_000 });
        if (!element) throw new Error(`Step ${index + 1}: target disappeared.`);
        await assertElementActionIsSafe(element, Boolean(options.capabilityGranted));
        await element.click({ timeout: options.timeoutMs ?? 10_000 });
        await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
      } else if (step.action === "type") {
        await assertNoHumanHandoffSignals(page);
        const locator = locatorForStep(page, step);
        const element = await locator.elementHandle({ timeout: options.timeoutMs ?? 10_000 });
        if (!element) throw new Error(`Step ${index + 1}: target disappeared.`);
        await assertElementIsSafeTextInput(element);
        await element.type(step.value ?? "", { timeout: options.timeoutMs ?? 10_000 });
      } else if (step.action === "fill") {
        await assertNoHumanHandoffSignals(page);
        const locator = locatorForStep(page, step);
        const element = await locator.elementHandle({ timeout: options.timeoutMs ?? 10_000 });
        if (!element) throw new Error(`Step ${index + 1}: target disappeared.`);
        await assertElementIsSafeTextInput(element);
        await element.fill(step.value ?? "", { timeout: options.timeoutMs ?? 10_000 });
      }

      throwIfWorkbenchAborted(options.signal);
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

    return await snapshotPage(page, {
      requestedUrl,
      capturedAtDate,
      screenshotPath,
      artifactPath,
      steps: results,
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    throw err;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await closeContext();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function throwIfWorkbenchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function assertElementActionIsSafe(element: ElementHandle, hasCapability: boolean): Promise<void> {
  const semantics = await element.evaluate((element) => {
    const node = element as unknown as {
      tagName?: string;
      type?: string;
      value?: string;
      form?: { action?: string; method?: string } | null;
      href?: string;
      innerText?: string;
      textContent?: string | null;
      getAttribute: (name: string) => string | null;
      closest: (selector: string) => unknown;
    };
    return {
      tagName: node.tagName?.toLowerCase() ?? "",
      role: node.getAttribute("role")?.toLowerCase() ?? "",
      type: node.type?.toLowerCase() ?? "",
      text: node.innerText ?? node.textContent ?? "",
      ariaLabel: node.getAttribute("aria-label") ?? "",
      title: node.getAttribute("title") ?? "",
      value: node.value ?? "",
      href: node.href ?? "",
      formAction: node.form?.action ?? "",
      formMethod: node.form?.method ?? "",
      insideForm: Boolean(node.form ?? node.closest("form")),
    } satisfies ResolvedElementSemantics;
  });
  const decision = assessResolvedElement(semantics, hasCapability);
  if (!decision.allowed) throw new Error(`Refusing to activate resolved element: ${decision.reason}.`);
}

async function assertElementIsSafeTextInput(element: ElementHandle): Promise<void> {
  const safe = await element.evaluate((element) => {
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
