// Telegram user-ID allowlist. The bot drops any message whose `from.id` isn't
// in this set. See DESIGN.md §12 — "the user-ID allowlist is the real defense"
// against random Telegram users discovering the bot.
//
// IDs come from .env (TELEGRAM_ALLOWED_USER_IDS) as a comma-separated list.

import { env } from "../config.js";

// Parse once at module load. Frozen for the process lifetime — to change
// allowed IDs, edit .env and restart.
export function parseAllowedUserIds(value: string): Set<number> {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one numeric user ID");

  const ids = entries.map((entry) => {
    if (!/^\d+$/.test(entry)) {
      throw new Error(`invalid Telegram user ID in TELEGRAM_ALLOWED_USER_IDS: ${JSON.stringify(entry)}`);
    }
    const id = Number(entry);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Telegram user ID is outside the safe positive integer range: ${JSON.stringify(entry)}`);
    }
    return id;
  });

  return new Set(ids);
}

const allowed = parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS);

export function isAllowed(userId: number): boolean {
  return allowed.has(userId);
}
