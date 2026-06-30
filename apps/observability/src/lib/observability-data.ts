import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ObservabilitySummary } from "../../../../src/observability/analytics";

type AnalyticsModule = {
  collectObservabilitySummary: () => Promise<ObservabilitySummary>;
  loadStoredObservabilitySummary: () => Promise<ObservabilitySummary | undefined>;
  writeObservabilitySummary: (summary: ObservabilitySummary) => Promise<void>;
};

const runtimeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<AnalyticsModule>;

async function loadAnalytics(): Promise<AnalyticsModule> {
  // Load the already-built JARVIS analytics module at runtime. Root scripts run
  // `pnpm build` before starting this Next app. `new Function` keeps Turbopack
  // from trying to statically bundle the NodeNext dist file.
  const modulePath = resolve(process.cwd(), "../../dist/observability/analytics.js");
  return runtimeImport(pathToFileURL(modulePath).href);
}

export async function getObservabilitySummary(refresh = false): Promise<ObservabilitySummary> {
  const analytics = await loadAnalytics();

  if (!refresh) {
    const stored = await analytics.loadStoredObservabilitySummary();
    if (stored) return stored;
  }

  const summary = await analytics.collectObservabilitySummary();
  await analytics.writeObservabilitySummary(summary);
  return summary;
}
