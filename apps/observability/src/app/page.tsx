import { ObservabilityDashboard } from "@/components/observability-dashboard";
import { getObservabilitySummary } from "@/lib/observability-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const summary = await getObservabilitySummary(false);
  return <ObservabilityDashboard summary={summary} />;
}
