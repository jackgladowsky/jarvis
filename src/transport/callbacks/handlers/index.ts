// Aggregates all callback handler registrations.
// Called once from telegram.ts before bot.start().
import { registerStopCallback } from "./stop.js";
import { registerBackgroundCallback } from "./background.js";
import { registerModelCallback } from "./model.js";
import { registerToggleCallback } from "./toggle.js";

export function registerAllCallbacks(): void {
  registerStopCallback();
  registerBackgroundCallback();
  registerModelCallback();
  registerToggleCallback();
}

export { buildBackgroundKeyboard } from "./background.js";
export { buildFavoritesKeyboard, getModelFavorites } from "./model.js";
