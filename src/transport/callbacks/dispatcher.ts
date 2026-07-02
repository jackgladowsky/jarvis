// Central callback query dispatcher — analogous to the command registry.
//
// Each handler registers with a prefix. When a callback_query arrives, the
// dispatcher matches `callback_query.data` against registered prefixes
// (longest-prefix first) and dispatches to the first match.
import type { Context } from "grammy";
import { log } from "../../lib/logger.js";

export type CallbackHandler = (ctx: Context, data: string) => Promise<void> | void;

interface CallbackRoute {
  prefix: string;
  handler: CallbackHandler;
}

const routes: CallbackRoute[] = [];

/** Register a callback handler for a given prefix. */
export function registerCallback(prefix: string, handler: CallbackHandler): void {
  if (routes.some((r) => r.prefix === prefix)) {
    throw new Error(`duplicate callback prefix: ${prefix}`);
  }
  routes.push({ prefix, handler });
}

/**
 * Dispatch an incoming callback query to the matching handler.
 * Returns true if a handler was found and called, false otherwise.
 */
export async function dispatchCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) return false;

  // Sort by prefix length descending so more specific prefixes win.
  const sorted = [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const route of sorted) {
    if (data === route.prefix || data.startsWith(route.prefix)) {
      try {
        await route.handler(ctx, data);
      } catch (err) {
        log.warn("callback handler error", {
          prefix: route.prefix,
          data,
          err: err instanceof Error ? err.message : err,
        });
        // Best-effort: tell the user something went wrong.
        await ctx.answerCallbackQuery({ text: "Something went wrong." }).catch(() => undefined);
      }
      return true;
    }
  }

  log.debug("unhandled callback query", { data });
  await ctx.answerCallbackQuery({ text: "Expired." }).catch(() => undefined);
  return false;
}
