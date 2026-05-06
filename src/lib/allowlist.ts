// Telegram user-ID allowlist. The bot drops any message whose `from.id` isn't
// in this set. See DESIGN.md §12 — "the user-ID allowlist is the real defense"
// against random Telegram users discovering the bot.
//
// IDs come from .env (TELEGRAM_ALLOWED_USER_IDS) as a comma-separated list.

import { env } from "../config.js";

// Parse once at module load. Frozen for the process lifetime — to change
// allowed IDs, edit .env and restart.
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
