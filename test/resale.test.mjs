import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "jarvis-resale-test-"));
mkdirSync(join(dataDir, "data", "jobs"), { recursive: true });
writeFileSync(join(dataDir, "config.yaml"), `
agent:
  provider: codex
  model: test-model
session:
  inactivity_threshold_minutes: 30
  max_duration_hours: 12
  summarize_on_rotation: false
  announce_new_session: false
compaction:
  enabled: false
  reserve_tokens: 1000
  keep_recent_tokens: 1000
tools:
  bash:
    default_timeout_seconds: 30
    max_timeout_seconds: 120
telegram:
  show_typing: false
  long_tool_call_seconds: 3
  parse_mode: HTML
scheduler:
  enabled: false
  timezone: UTC
  telegram_chat_id: 1
  tasks: []
logging:
  audit_log_enabled: false
  audit_log_max_value_bytes: 1000
  audit_log_redact_patterns: true
  level: error
`);

process.env.JARVIS_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
process.env.EXA_API_KEY = "test-exa";

const resale = await import("../dist/watchers/resale.js");

function listing(overrides) {
  return {
    id: overrides.id ?? "id-1",
    title: overrides.title ?? "Fendi Baguette bag in good condition",
    priceUsd: overrides.priceUsd ?? 3000,
    source: overrides.source ?? "eBay",
    url: overrides.url ?? "https://example.com/item/1",
    ...overrides,
  };
}

test("filterEligibleListings applies USD max price threshold", () => {
  const matches = resale.filterEligibleListings([
    listing({ id: "low", priceUsd: 3500, condition: "Good" }),
    listing({ id: "high", priceUsd: 3500.01, condition: "Excellent" }),
  ], { max_price_usd: 3500, min_condition: "good" });

  assert.deepEqual(matches.map((item) => item.id), ["low"]);
});

test("condition handling requires explicit good-or-better evidence", () => {
  assert.equal(resale.passesCondition(listing({ condition: "Used", title: "Fendi Baguette pre-owned" }), "good"), false);
  assert.equal(resale.passesCondition(listing({ condition: undefined, title: "Fendi Baguette" }), "good"), false);
  assert.equal(resale.passesCondition(listing({ condition: "Pre-owned", title: "Fendi Baguette in excellent condition" }), "good"), true);
  assert.equal(resale.passesCondition(listing({ condition: "Used", title: "Fendi Baguette", descriptionText: "Good condition, minor wear." }), "good"), true);
  assert.equal(resale.passesCondition(listing({ condition: "Excellent", title: "Fendi Baguette with stain" }), "good"), false);
  assert.equal(resale.passesCondition(listing({ condition: "Good", title: "Fendi Baguette" }), "excellent"), false);
});

test("dedupeListings keeps the first listing per stable id", () => {
  const matches = resale.dedupeListings([
    listing({ id: "same", title: "First", priceUsd: 3200 }),
    listing({ id: "same", title: "Second", priceUsd: 2800 }),
    listing({ id: "other", title: "Third", priceUsd: 3000 }),
  ]);

  assert.deepEqual(matches.map((item) => item.title), ["First", "Third"]);
});

test("collectSourceListings records source errors while preserving successful source results", async () => {
  const watcher = {
    query: "Fendi Baguette bag",
    max_price_usd: 3500,
    min_condition: "good",
    sources: [
      { type: "ebay", query: "fail" },
      { type: "ebay", query: "ok" },
    ],
  };

  const result = await resale.collectSourceListings(watcher, async (source) => {
    if (source.query === "fail") throw new Error("upstream 503");
    return [listing({ id: "ok" })];
  });

  assert.equal(result.succeeded, 1);
  assert.deepEqual(result.failed, [{ source: "ebay", error: "upstream 503" }]);
  assert.deepEqual(result.listings.map((item) => item.id), ["ok"]);
});
