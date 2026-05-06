import { env } from "../config.js";

const allowed = new Set(
  env.TELEGRAM_ALLOWED_USER_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n)),
);

export function isAllowed(userId: number): boolean {
  return allowed.has(userId);
}
