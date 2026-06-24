export const MAX_VISIBLE_TEXT_CHARS = 4000;

export interface WorkbenchStepResult {
  index: number;
  action: string;
  target: string;
  startedUrl: string;
  endedUrl: string;
}

export interface WorkbenchPageSnapshot {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  visibleText: string;
  screenshotPath: string;
  artifactPath: string;
  capturedAt: string;
  steps?: WorkbenchStepResult[];
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
  const stepLines = snapshot.steps?.length
    ? [
        "",
        "Steps:",
        ...snapshot.steps.map(
          (step) =>
            `${step.index}. ${step.action} ${clipVisibleText(step.target, 120).text || "(unknown)"} -> ${step.endedUrl}`,
        ),
      ]
    : [];

  return [
    `Browser workbench result: ${snapshot.finalUrl}`,
    `Title: ${snapshot.title || "(untitled)"}`,
    `Captured: ${snapshot.capturedAt}`,
    `Screenshot: ${snapshot.screenshotPath}`,
    `Artifact: ${snapshot.artifactPath}`,
    ...stepLines,
    "",
    "Visible text:",
    clipped.text || "(no visible text captured)",
    clipped.truncated ? "\n[visible text truncated]" : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
