import { isIP } from "node:net";

export type WorkbenchAction = "open_url" | "click" | "type" | "submit" | "download";

export interface SafetyDecision {
  allowed: boolean;
  reason?: string;
}

export interface ApprovalDecision {
  approvalRequired: boolean;
  matchedTerms: string[];
  reason?: string;
}

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [ip4ToNumber("10.0.0.0"), ip4ToNumber("10.255.255.255")],
  [ip4ToNumber("172.16.0.0"), ip4ToNumber("172.31.255.255")],
  [ip4ToNumber("192.168.0.0"), ip4ToNumber("192.168.255.255")],
  [ip4ToNumber("127.0.0.0"), ip4ToNumber("127.255.255.255")],
  [ip4ToNumber("169.254.0.0"), ip4ToNumber("169.254.255.255")],
  [ip4ToNumber("0.0.0.0"), ip4ToNumber("0.255.255.255")],
];

const RISKY_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "purchase", pattern: /\b(buy|purchase|checkout|place\s+(?:the\s+)?order|pay|payment)\b/i },
  { label: "order", pattern: /\b(order|doordash|instacart|cart)\b/i },
  { label: "booking", pattern: /\b(book|reserve|reservation|ride|uber|lyft|flight|hotel|appointment)\b/i },
  { label: "send/post", pattern: /\b(send|post|publish|submit|message|email|reply|comment|tweet)\b/i },
  { label: "delete/cancel", pattern: /\b(delete|remove|cancel|close\s+(?:my\s+)?account|terminate)\b/i },
  {
    label: "account change",
    pattern: /\b(change\s+(?:my\s+)?(?:password|email|address|plan)|update\s+(?:my\s+)?(?:account|profile|billing))\b/i,
  },
  { label: "financial", pattern: /\b(bank|wire|transfer|trade|sell|invest|loan|tax|refund|crypto|stock)\b/i },
  { label: "legal", pattern: /\b(legal|contract|lawsuit|settlement|notar|attorney|lawyer)\b/i },
  { label: "medical", pattern: /\b(medical|doctor|prescription|pharmacy|diagnos|treatment|health insurance)\b/i },
];

function ip4ToNumber(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const n = ip4ToNumber(hostname);
  return PRIVATE_IPV4_RANGES.some(([start, end]) => n >= start && n <= end);
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (isIP(normalized) !== 6) return false;
  return (
    normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80")
  );
}

export function validateWorkbenchUrl(input: string): SafetyDecision & { url?: URL } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { allowed: false, reason: "Invalid URL." };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return { allowed: false, reason: "Only http(s) URLs are allowed." };
  }

  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!hostname) return { allowed: false, reason: "URL is missing a hostname." };
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return { allowed: false, reason: "Local hostnames are blocked for the browser workbench." };
  }
  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    return { allowed: false, reason: "Private, loopback, and link-local IPs are blocked for the browser workbench." };
  }

  return { allowed: true, url };
}

export function assessWorkbenchRequest(text: string): ApprovalDecision {
  const matchedTerms = RISKY_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.label);
  return {
    approvalRequired: matchedTerms.length > 0,
    matchedTerms,
    reason: matchedTerms.length
      ? `Hard approval required before: ${Array.from(new Set(matchedTerms)).join(", ")}.`
      : undefined,
  };
}

export function assertReadOnlyWorkbenchAction(action: WorkbenchAction): SafetyDecision {
  if (action === "open_url") return { allowed: true };
  return { allowed: false, reason: `Workbench action ${action} is not implemented without human approval.` };
}
