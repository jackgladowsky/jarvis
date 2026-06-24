import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { paths } from "../paths.js";
import { clipVisibleText, type WorkbenchPageSnapshot } from "./render.js";
import { assertReadOnlyWorkbenchAction, validateWorkbenchUrl } from "./safety.js";

export interface OpenUrlOptions {
  timeoutMs?: number;
  now?: Date;
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

export async function openUrlInWorkbench(
  inputUrl: string,
  options: OpenUrlOptions = {},
): Promise<WorkbenchPageSnapshot> {
  const action = assertReadOnlyWorkbenchAction("open_url");
  if (!action.allowed) throw new Error(action.reason);

  const validation = validateWorkbenchUrl(inputUrl);
  if (!validation.allowed || !validation.url) throw new Error(validation.reason ?? "URL is not allowed.");

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

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(validation.url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs ?? 30_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);

    const title = await page.title();
    const rawText = await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "");
    const visibleText = clipVisibleText(rawText).text;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const snapshot: WorkbenchPageSnapshot = {
      requestedUrl: validation.url.toString(),
      finalUrl: page.url(),
      title,
      visibleText,
      screenshotPath,
      artifactPath,
      capturedAt: capturedAtDate.toISOString(),
    };
    await writeFile(artifactPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
    return snapshot;
  } finally {
    await context.close();
  }
}
