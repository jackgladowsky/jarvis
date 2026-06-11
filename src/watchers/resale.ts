import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { env } from "../config.js";
import { log } from "../lib/logger.js";
import { paths } from "../paths.js";

export type ResaleWatcherCondition = "new" | "excellent" | "very_good" | "good";

export interface EbayResaleSourceConfig {
  type: "ebay";
  enabled?: boolean;
  query?: string;
  marketplace?: "US";
}

export type ResaleSourceConfig = EbayResaleSourceConfig;

export interface ResaleWatcherConfig {
  query: string;
  max_price_usd: number;
  min_condition: ResaleWatcherCondition;
  sources: ResaleSourceConfig[];
}

export interface ResaleListing {
  id: string;
  title: string;
  priceUsd: number;
  condition?: string;
  source: string;
  photoUrl?: string;
  url: string;
  descriptionText?: string;
}

export interface SourceCollectionResult {
  listings: ResaleListing[];
  succeeded: number;
  failed: Array<{ source: string; error: string }>;
}

interface SeenState {
  seen: Record<string, string>;
}

interface TelegramSendOptions {
  chatId: number;
  text: string;
  photoUrl?: string;
}

interface EbayFindingItem {
  itemId?: string[];
  title?: string[];
  viewItemURL?: string[];
  galleryURL?: string[];
  sellingStatus?: Array<{
    currentPrice?: Array<{ __value__?: string; "@currencyId"?: string }>;
  }>;
  condition?: Array<{ conditionDisplayName?: string[] }>;
}

const CONDITION_RANK: Record<ResaleWatcherCondition, number> = {
  good: 0,
  very_good: 1,
  excellent: 2,
  new: 3,
};

const BAD_CONDITION_PATTERNS = [
  /\bdamaged?\b/i,
  /\bpoor\b/i,
  /\bfair\b/i,
  /\bstains?\b/i,
  /\bstained\b/i,
  /\bneeds?\s+repairs?\b/i,
  /\brepairs?\s+needed\b/i,
  /\bas\s+is\b/i,
  /\bfor\s+parts\b/i,
  /\bbroken\b/i,
  /\bdefects?\b/i,
  /\bdefective\b/i,
  /\bheavily\s+worn\b/i,
  /\bworn\s+out\b/i,
  /\bflaws?\b/i,
  /\bflawed\b/i,
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function tagValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!match) return undefined;
  return decodeXml(stripCdata(match[1].trim()));
}

function attrValue(xml: string, attr: string): string | undefined {
  const match = new RegExp(`${attr}=["']([^"']+)["']`, "i").exec(xml);
  return match ? decodeXml(match[1]) : undefined;
}

function tagFragment(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}(?:\\s[^>]*)?/?>`, "i").exec(xml)?.[0];
}

function imageFromHtml(html: string): string | undefined {
  const match = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html);
  return match ? decodeXml(match[1]) : undefined;
}

function normalizeLink(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("mkcid") || key.toLowerCase().startsWith("mkrid")) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function stableListingId(source: string, url: string, title: string): string {
  const itemId = /\/itm\/(?:[^/]+\/)?(\d+)/.exec(url)?.[1] ?? /[?&]item=(\d+)/.exec(url)?.[1];
  if (itemId) return `${source}:${itemId}`;
  const hash = createHash("sha256").update(`${source}\n${url}\n${title}`).digest("hex").slice(0, 24);
  return `${source}:${hash}`;
}

function parsePriceUsd(text: string): number | undefined {
  const normalized = text.replace(/,/g, "");
  const match = /(?:US\s*)?\$\s*(\d+(?:\.\d{1,2})?)/i.exec(normalized);
  if (!match) return undefined;
  return Number.parseFloat(match[1]);
}

function parseCondition(text: string): string | undefined {
  const match = /Condition:\s*([^<\n|]+)/i.exec(text);
  return match?.[1]?.trim();
}

export function conditionRank(condition: string): number | undefined {
  const lower = condition.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const hasToken = (token: string) => lower === token || lower.startsWith(`${token}_`) || lower.endsWith(`_${token}`) || lower.includes(`_${token}_`);
  const hasPhrase = (phrase: string) => lower.includes(phrase.replace(/[^a-z0-9]+/g, "_"));

  if (["new", "mint", "unused", "nwt"].some(hasToken) || ["never used", "new with tags"].some(hasPhrase)) return CONDITION_RANK.new;
  if (["excellent", "pristine"].some(hasToken) || hasPhrase("like new")) return CONDITION_RANK.excellent;
  if (hasPhrase("very good") || hasToken("great") || hasPhrase("gently used")) return CONDITION_RANK.very_good;
  if (hasToken("good")) return CONDITION_RANK.good;
  if (["fair", "poor", "parts", "repair", "damaged", "damage", "defect", "defects", "flaw", "flaws"].some(hasToken)) return -1;
  return undefined;
}

function conditionEvidence(listing: ResaleListing): string {
  return [listing.condition, listing.title, listing.descriptionText].filter(Boolean).join("\n");
}

export function passesCondition(listing: ResaleListing, minCondition: ResaleWatcherCondition): boolean {
  const evidence = conditionEvidence(listing);
  if (BAD_CONDITION_PATTERNS.some((pattern) => pattern.test(evidence))) return false;

  // eBay's generic "Used" / "Pre-owned" only means "not new". It does not
  // prove Jack's requested floor of good-or-better, so require an explicit
  // good/excellent/new signal in the condition, title, or description.
  const rank = conditionRank(evidence);
  return rank !== undefined && rank >= CONDITION_RANK[minCondition];
}

export function filterEligibleListings(listings: ResaleListing[], watcher: Pick<ResaleWatcherConfig, "max_price_usd" | "min_condition">): ResaleListing[] {
  return listings
    .filter((listing) => listing.priceUsd <= watcher.max_price_usd)
    .filter((listing) => passesCondition(listing, watcher.min_condition))
    .sort((a, b) => a.priceUsd - b.priceUsd);
}

export function dedupeListings(listings: ResaleListing[]): ResaleListing[] {
  const seen = new Set<string>();
  const unique: ResaleListing[] = [];
  for (const listing of listings) {
    if (seen.has(listing.id)) continue;
    seen.add(listing.id);
    unique.push(listing);
  }
  return unique;
}

function ebayFindingUrl(query: string): string {
  const params = new URLSearchParams({
    "OPERATION-NAME": "findItemsAdvanced",
    "SERVICE-VERSION": "1.13.0",
    "SECURITY-APPNAME": env.EBAY_APP_ID ?? "",
    "RESPONSE-DATA-FORMAT": "JSON",
    "REST-PAYLOAD": "true",
    keywords: query,
    "paginationInput.entriesPerPage": "50",
    "sortOrder": "StartTimeNewest",
    "itemFilter(0).name": "LocatedIn",
    "itemFilter(0).value": "US",
    "itemFilter(1).name": "Currency",
    "itemFilter(1).value": "USD",
    "itemFilter(2).name": "Condition",
    "itemFilter(2).value(0)": "1000",
    "itemFilter(2).value(1)": "1500",
    "itemFilter(2).value(2)": "2000",
    "itemFilter(2).value(3)": "2500",
    "itemFilter(2).value(4)": "3000",
  });
  return `https://svcs.ebay.com/services/search/FindingService/v1?${params.toString()}`;
}

function ebaySearchUrl(query: string): string {
  const params = new URLSearchParams({
    _nkw: query,
    _sacat: "0",
    _from: "R40",
    _rss: "1",
    LH_ItemCondition: "1000|1500|2000|2500|3000",
    LH_PrefLoc: "1",
    _sop: "10",
  });
  return `https://www.ebay.com/sch/i.html?${params.toString()}`;
}

function parseEbayFindingItems(json: unknown): EbayFindingItem[] {
  const root = json as {
    findItemsAdvancedResponse?: Array<{
      searchResult?: Array<{ item?: EbayFindingItem[] }>;
    }>;
  };
  return root.findItemsAdvancedResponse?.[0]?.searchResult?.[0]?.item ?? [];
}

async function fetchEbayFindingListings(query: string): Promise<ResaleListing[]> {
  if (!env.EBAY_APP_ID) return [];
  const response = await fetch(ebayFindingUrl(query), {
    headers: {
      "accept": "application/json",
      "user-agent": "JARVIS resale watcher (+https://github.com/jackgladowsky/jarvis)",
    },
  });
  if (!response.ok) throw new Error(`eBay Finding API failed: ${response.status} ${await response.text()}`);
  const items = parseEbayFindingItems(await response.json());
  return items.flatMap((item) => {
    const title = item.title?.[0];
    const rawLink = item.viewItemURL?.[0];
    const price = item.sellingStatus?.[0]?.currentPrice?.[0];
    const priceUsd = price?.["@currencyId"] === "USD" && price.__value__
      ? Number.parseFloat(price.__value__)
      : undefined;
    if (!title || !rawLink || priceUsd === undefined || Number.isNaN(priceUsd)) return [];
    const url = normalizeLink(rawLink);
    const itemId = item.itemId?.[0];
    return [{
      id: itemId ? `eBay:${itemId}` : stableListingId("eBay", url, title),
      title,
      priceUsd,
      condition: item.condition?.[0]?.conditionDisplayName?.[0],
      source: "eBay",
      photoUrl: item.galleryURL?.[0],
      url,
    }];
  });
}

async function fetchEbayRssListings(query: string): Promise<ResaleListing[]> {
  const response = await fetch(ebaySearchUrl(query), {
    headers: {
      "accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "user-agent": "Mozilla/5.0 JARVIS resale watcher (+https://github.com/jackgladowsky/jarvis)",
    },
  });
  if (!response.ok) throw new Error(`eBay RSS failed: ${response.status} ${await response.text()}`);
  const rss = await response.text();
  const itemMatches = rss.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  return itemMatches.flatMap((item) => {
    const title = tagValue(item, "title");
    const rawLink = tagValue(item, "link") ?? tagValue(item, "guid");
    const description = tagValue(item, "description") ?? "";
    const media = tagFragment(item, "media:content") ?? tagFragment(item, "media:thumbnail") ?? "";
    const photoUrl = attrValue(media, "url") ?? tagValue(item, "image") ?? imageFromHtml(description);
    const priceUsd = parsePriceUsd(`${title ?? ""}\n${description}`);
    if (!title || !rawLink || priceUsd === undefined) return [];
    const url = normalizeLink(rawLink);
    return [{
      id: stableListingId("eBay", url, title),
      title,
      priceUsd,
      condition: parseCondition(description),
      source: "eBay",
      photoUrl,
      url,
      descriptionText: description,
    }];
  });
}

async function fetchEbayListings(config: EbayResaleSourceConfig, fallbackQuery: string): Promise<ResaleListing[]> {
  if (config.enabled === false) return [];
  const query = config.query ?? fallbackQuery;
  if (!env.EBAY_APP_ID) return fetchEbayRssListings(query);

  try {
    return await fetchEbayFindingListings(query);
  } catch (err) {
    log.warn(`eBay Finding API failed; trying RSS fallback: ${(err as Error).message}`);
    return fetchEbayRssListings(query);
  }
}

async function fetchSourceListings(source: ResaleSourceConfig, fallbackQuery: string): Promise<ResaleListing[]> {
  if (source.type === "ebay") return fetchEbayListings(source, fallbackQuery);
  return [];
}

export async function collectSourceListings(
  config: ResaleWatcherConfig,
  fetcher: (source: ResaleSourceConfig, fallbackQuery: string) => Promise<ResaleListing[]> = fetchSourceListings,
): Promise<SourceCollectionResult> {
  const listings: ResaleListing[] = [];
  const failed: SourceCollectionResult["failed"] = [];
  let succeeded = 0;

  for (const source of config.sources) {
    if (source.enabled === false) continue;
    try {
      listings.push(...await fetcher(source, config.query));
      succeeded += 1;
    } catch (err) {
      const sourceName = source.type;
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ source: sourceName, error: message });
      log.warn(`Resale watcher source failed (${sourceName}): ${message}`);
    }
  }

  return { listings, succeeded, failed };
}

async function readSeenState(path: string): Promise<SeenState> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as SeenState;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { seen: {} };
    throw err;
  }
}

async function writeSeenState(path: string, state: SeenState): Promise<void> {
  await mkdir(join(paths.scheduledJobs, "state"), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function statePath(taskId: string): string {
  return join(paths.scheduledJobs, "state", `${taskId}.resale-seen.json`);
}

function alertText(listing: ResaleListing, maxPriceUsd: number): string {
  const conditionLine = listing.condition ? `\nCondition: ${escapeHtml(listing.condition)}` : "";
  return [
    "<b>Fendi Baguette resale watch</b>",
    "",
    `<b>${escapeHtml(listing.title)}</b>`,
    `Price: $${listing.priceUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} (≤ $${maxPriceUsd.toLocaleString("en-US")})`,
    `${conditionLine ? conditionLine.slice(1) : "Condition: not listed"}`,
    `Source: ${escapeHtml(listing.source)}`,
    `<a href=\"${escapeHtml(listing.url)}\">Listing</a>`,
  ].join("\n");
}

async function sendTelegramAlert({ chatId, text, photoUrl }: TelegramSendOptions): Promise<void> {
  if (photoUrl) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: text.slice(0, 1024),
        parse_mode: "HTML",
      }),
    });
    if (response.ok) return;
    log.warn(`Telegram sendPhoto failed, falling back to text: ${response.status} ${await response.text()}`);
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: false },
    }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
}

export async function runResaleWatcher(taskId: string, watcher: ResaleWatcherConfig, chatId: number): Promise<string> {
  const collection = await collectSourceListings(watcher);
  if (collection.succeeded === 0) {
    const errors = collection.failed.map((failure) => `${failure.source}: ${failure.error}`).join("; ");
    throw new Error(`Resale watcher had no successful sources${errors ? ` (${errors})` : ""}`);
  }

  const listings = dedupeListings(collection.listings);
  const matches = filterEligibleListings(listings, watcher);

  const seenPath = statePath(taskId);
  const state = await readSeenState(seenPath);
  const fresh = matches.filter((listing) => !(listing.id in state.seen));

  for (const listing of fresh) {
    await sendTelegramAlert({
      chatId,
      text: alertText(listing, watcher.max_price_usd),
      photoUrl: listing.photoUrl,
    });
    state.seen[listing.id] = new Date().toISOString();
  }

  for (const listing of matches) {
    state.seen[listing.id] ??= new Date().toISOString();
  }
  await writeSeenState(seenPath, state);

  const sourceFailureNote = collection.failed.length > 0
    ? ` Source failures: ${collection.failed.map((failure) => `${failure.source} (${failure.error})`).join(", ")}.`
    : "";
  return `Resale watcher checked ${listings.length} listings; ${matches.length} matched; ${fresh.length} new Telegram listing notification${fresh.length === 1 ? "" : "s"}.${sourceFailureNote}`;
}
