export interface ResolvedElementSemantics {
  tagName: string;
  role: string;
  type: string;
  text: string;
  ariaLabel: string;
  title: string;
  value: string;
  href: string;
  formAction: string;
  formMethod: string;
  insideForm: boolean;
}

export interface ResolvedElementDecision {
  allowed: boolean;
  capabilityRequired: boolean;
  reason?: string;
}

const HUMAN_HANDOFF =
  /\b(password|passcode|otp|2fa|mfa|captcha|verification code|credit.?card|card.?number|cvv|cvc|ssn|secret|token|api.?key|log\s?in|sign\s?in)\b/i;
const PURCHASE = /\b(buy|purchase|checkout|place\s+(?:the\s+)?order|pay(?:ment)?|cart)\b/i;
const RISKY = /\b(send|post|publish|confirm|delete|remove|cancel|save changes|update account|transfer)\b/i;

export function assessResolvedElement(
  element: ResolvedElementSemantics,
  hasCapability: boolean,
): ResolvedElementDecision {
  const text = [
    element.role,
    element.type,
    element.text,
    element.ariaLabel,
    element.title,
    element.value,
    element.href,
    element.formAction,
    element.formMethod,
  ].join(" ");
  if (HUMAN_HANDOFF.test(text))
    return { allowed: false, capabilityRequired: false, reason: "credential/login/2FA/CAPTCHA target" };
  if (PURCHASE.test(text))
    return { allowed: false, capabilityRequired: false, reason: "purchase and payment actions are not implemented" };
  const implicitSubmit =
    element.insideForm &&
    (element.tagName === "button" || (element.tagName === "input" && ["submit", "image"].includes(element.type))) &&
    element.type !== "button";
  const capabilityRequired = implicitSubmit || element.type === "submit" || RISKY.test(text);
  if (capabilityRequired && !hasCapability) {
    return { allowed: false, capabilityRequired: true, reason: "resolved element semantics require owner approval" };
  }
  return { allowed: true, capabilityRequired };
}
