import { isIP } from "node:net";

export type WorkbenchAction = "open_url" | "click" | "type" | "fill" | "submit" | "download";

export interface SafetyDecision {
  allowed: boolean;
  reason?: string;
}

export interface ApprovalDecision {
  approvalRequired: boolean;
  matchedTerms: string[];
  reason?: string;
}

export interface WorkbenchStep {
  action: "open_url" | "click" | "type" | "fill" | "submit";
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
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
  { label: "send/post", pattern: /\b(send|post|publish|message|email|reply|comment|tweet)\b/i },
  { label: "delete/cancel", pattern: /\b(delete|remove|cancel|close\s+(?:my\s+)?account|terminate)\b/i },
  {
    label: "account change",
    pattern: /\b(change\s+(?:my\s+)?(?:password|email|address|plan)|update\s+(?:my\s+)?(?:account|profile|billing))\b/i,
  },
  { label: "financial", pattern: /\b(bank|wire|transfer|trade|sell|invest|loan|tax|refund|crypto|stock)\b/i },
  { label: "legal", pattern: /\b(legal|contract|lawsuit|settlement|notar|attorney|lawyer)\b/i },
  { label: "medical", pattern: /\b(medical|doctor|prescription|pharmacy|diagnos|treatment|health insurance)\b/i },
];

const HUMAN_HANDOFF_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "credential",
    pattern: /\b(password|passcode|credential|(?<!non-)secret|api[_ -]?key|token|seed phrase|private key)\b/i,
  },
  { label: "login", pattern: /\b(log\s?in|sign\s?in|sign on|authenticate|auth code)\b/i },
  { label: "2fa", pattern: /\b(2fa|mfa|two[- ]factor|verification code|otp|one[- ]time code)\b/i },
  { label: "captcha", pattern: /\b(captcha|recaptcha|hcaptcha|human verification)\b/i },
];

const DANGEROUS_CLICK_TEXT =
  /\b(send|post|publish|buy|purchase|checkout|pay|payment|place order|book|reserve|confirm|delete|remove|cancel|save changes|update account|transfer|sign in|log in)\b/i;
const SENSITIVE_FIELD_HINT =
  /\b(password|passcode|otp|2fa|mfa|captcha|verification|credit.?card|card.?number|cvv|cvc|ssn|social.?security|secret|token|api.?key)\b/i;

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
      ? `Owner confirmation required when enabled before: ${Array.from(new Set(matchedTerms)).join(", ")}.`
      : undefined,
  };
}

export function assessHumanHandoff(text: string): ApprovalDecision {
  const matchedTerms = HUMAN_HANDOFF_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.label);
  return {
    approvalRequired: matchedTerms.length > 0,
    matchedTerms,
    reason: matchedTerms.length
      ? `Human handoff required for: ${Array.from(new Set(matchedTerms)).join(", ")}. Credentials/login/2FA/CAPTCHA are not automated.`
      : undefined,
  };
}

export function isUnimplementedPurchaseRequest(text: string): boolean {
  return /\b(buy|purchase|checkout|place\s+(?:the\s+)?order|pay(?:ment)?|doordash|instacart|cart)\b/i.test(text);
}

export function workbenchPlanRequiresCapability(steps: WorkbenchStep[], request = ""): boolean {
  if (assessWorkbenchRequest(request).approvalRequired) return true;
  return steps.some(
    (step) =>
      step.action === "submit" ||
      (step.action === "click" && DANGEROUS_CLICK_TEXT.test([step.selector, step.text].filter(Boolean).join(" "))),
  );
}

export function assertWorkbenchActionAllowed(action: WorkbenchAction): SafetyDecision {
  if (action === "open_url" || action === "click" || action === "type" || action === "fill" || action === "submit")
    return { allowed: true };
  return { allowed: false, reason: `Workbench action ${action} is not implemented.` };
}

export function assertReadOnlyWorkbenchAction(action: WorkbenchAction): SafetyDecision {
  if (action === "open_url") return { allowed: true };
  return { allowed: false, reason: `Workbench action ${action} is not read-only.` };
}

export function validateWorkbenchSteps(
  steps: WorkbenchStep[],
  options: { request?: string; hasCapability?: boolean; allowNoOpen?: boolean } = {},
): SafetyDecision {
  if (!steps.length) return { allowed: false, reason: "At least one workbench step is required." };
  if (steps.length > 20) return { allowed: false, reason: "Workbench run is limited to 20 steps." };

  if (isUnimplementedPurchaseRequest(options.request ?? "")) {
    return { allowed: false, reason: "Purchases, checkout, orders, and payments are not implemented." };
  }
  const requestApproval = assessWorkbenchRequest(options.request ?? "");
  if (requestApproval.approvalRequired && !options.hasCapability) {
    return { allowed: false, reason: `${requestApproval.reason} Owner-issued capability required.` };
  }

  let hasOpen = false;
  for (const [index, step] of steps.entries()) {
    const action = assertWorkbenchActionAllowed(step.action);
    if (!action.allowed) return action;

    const targetText = [step.selector, step.text].filter(Boolean).join(" ");
    const stepText = [targetText, step.value].filter(Boolean).join(" ");
    const handoff = assessHumanHandoff(stepText);
    if (handoff.approvalRequired) return { allowed: false, reason: `Step ${index + 1}: ${handoff.reason}` };

    if (step.action === "open_url") {
      if (!step.url) return { allowed: false, reason: `Step ${index + 1}: open_url requires url.` };
      const url = validateWorkbenchUrl(step.url);
      if (!url.allowed) return { allowed: false, reason: `Step ${index + 1}: ${url.reason}` };
      hasOpen = true;
      continue;
    }

    if (!step.selector && !step.text) {
      return { allowed: false, reason: `Step ${index + 1}: ${step.action} requires selector or text.` };
    }

    if (step.action === "click" || step.action === "submit") {
      if (step.value) return { allowed: false, reason: `Step ${index + 1}: ${step.action} does not accept value.` };
      if (step.action === "submit" && !options.hasCapability) {
        return { allowed: false, reason: `Step ${index + 1}: submit requires an owner-issued capability.` };
      }
      if (DANGEROUS_CLICK_TEXT.test(stepText) && !options.hasCapability) {
        return {
          allowed: false,
          reason: `Step ${index + 1}: ${step.action} target looks side-effect/destructive; owner-issued capability required.`,
        };
      }
      continue;
    }

    if ((step.action === "type" || step.action === "fill") && !step.value) {
      return { allowed: false, reason: `Step ${index + 1}: ${step.action} requires non-secret value.` };
    }
    if ((step.action === "type" || step.action === "fill") && SENSITIVE_FIELD_HINT.test(targetText)) {
      return {
        allowed: false,
        reason: `Step ${index + 1}: sensitive credential/payment field detected; human handoff required.`,
      };
    }
  }

  if (!hasOpen && !options.allowNoOpen) return { allowed: false, reason: "First run must include an open_url step." };
  return { allowed: true };
}
