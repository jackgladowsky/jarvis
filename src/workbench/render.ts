export const MAX_VISIBLE_TEXT_CHARS = 4000;

export interface WorkbenchPageSnapshot {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  visibleText: string;
  screenshotPath: string;
  artifactPath: string;
  capturedAt: string;
}

export function clipVisibleText(text: string, maxChars = MAX_VISIBLE_TEXT_CHARS): { text: string; truncated: boolean } {
  const normalized = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  return { text: `${normalized.slice(0, maxChars - 1)}…`, truncated: true };
}

export function renderWorkbenchResult(snapshot: WorkbenchPageSnapshot): string {
  const clipped = clipVisibleText(snapshot.visibleText, 1200);
  return [
    `Browser workbench opened: ${snapshot.finalUrl}`,
    `Title: ${snapshot.title || "(untitled)"}`,
    `Captured: ${snapshot.capturedAt}`,
    `Screenshot: ${snapshot.screenshotPath}`,
    `Artifact: ${snapshot.artifactPath}`,
    "",
    "Visible text:",
    clipped.text || "(no visible text captured)",
    clipped.truncated ? "\n[visible text truncated]" : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
