/**
 * Goal commands: `/goal [sub] [args…]`.
 *
 * `/goal` is a dispatcher: `start`, `list`, `status`, `pause`, `resume`,
 * `stop`, `next`, `log`. Behavior is preserved verbatim from the previous
 * inline implementation in `telegram.ts`.
 */
import type { Context } from "grammy";
import { log } from "../../../lib/logger.js";
import { commandName, commandRest } from "../../commands.js";
import {
  listGoals,
  readGoal,
  readGoalEvents,
  renderGoal,
  renderGoalEvents,
  renderGoalList,
  resumeGoal,
  setGoalStatus,
  startGoal,
  startNextGoalTask,
} from "../../../goals/manager.js";
import { parseGoalStartArgs } from "../../../goals/logic.js";
import type { CommandDef, ParsedCommand } from "../registry.js";

async function safeReply(ctx: Context, label: string, body: string): Promise<void> {
  try {
    await ctx.reply(body);
  } catch (err) {
    log.debug("telegram call failed", { label, err: err instanceof Error ? err.message : err });
  }
}

export async function handleGoal(ctx: Context, parsed: ParsedCommand): Promise<void> {
  const chatId = ctx.chat!.id;
  // Re-parse from raw to preserve exact pre-refactor behavior including the
  // `commandName(trimmed) !== "goal"` short-circuit and subcommand dispatch.
  const trimmed = parsed.raw;
  if (commandName(trimmed) !== "goal") return;
  const rest = commandRest(trimmed);
  const [sub = "help", ...parts] = rest.split(/\s+/);
  const arg = parts.join(" ").trim();

  try {
    if (["help", ""].includes(sub)) {
      await safeReply(
        ctx,
        "reply (/goal help)",
        "Usage: /goal start [--max-tasks N] [--max-minutes N] [--max-failures N] [--auto] <objective>\n/goal list\n/goal status <id>\n/goal pause|resume|stop|next <id>\n/goal log <id>",
      );
      return;
    }

    if (sub === "start") {
      const started = parseGoalStartArgs(arg);
      if (!started) {
        await safeReply(
          ctx,
          "reply (/goal start usage)",
          "Usage: /goal start [--max-tasks N] [--max-minutes N] [--max-failures N] [--auto] <objective>",
        );
        return;
      }
      const goal = await startGoal(started.objective, chatId, started.options);
      await safeReply(ctx, "reply (/goal start)", `Started ${goal.id}.\n${renderGoal(goal)}`);
      return;
    }

    if (sub === "list") {
      await safeReply(ctx, "reply (/goal list)", renderGoalList(await listGoals()));
      return;
    }

    if (sub === "status") {
      if (!arg) {
        await safeReply(ctx, "reply (/goal status usage)", "Usage: /goal status <id>");
        return;
      }
      await safeReply(ctx, "reply (/goal status)", renderGoal(await readGoal(arg)));
      return;
    }

    if (sub === "pause" || sub === "stop") {
      if (!arg) {
        await safeReply(ctx, "reply (/goal state usage)", `Usage: /goal ${sub} <id>`);
        return;
      }
      const goal = await setGoalStatus(arg, sub === "pause" ? "paused" : "stopped", `${sub} requested from Telegram`);
      await safeReply(ctx, `reply (/goal ${sub})`, renderGoal(goal));
      return;
    }

    if (sub === "resume") {
      if (!arg) {
        await safeReply(ctx, "reply (/goal resume usage)", "Usage: /goal resume <id>");
        return;
      }
      await safeReply(ctx, "reply (/goal resume)", renderGoal(await resumeGoal(arg)));
      return;
    }

    if (sub === "next") {
      if (!arg) {
        await safeReply(ctx, "reply (/goal next usage)", "Usage: /goal next <id>");
        return;
      }
      await safeReply(ctx, "reply (/goal next)", renderGoal(await startNextGoalTask(arg, "manual /goal next")));
      return;
    }

    if (sub === "log") {
      if (!arg) {
        await safeReply(ctx, "reply (/goal log usage)", "Usage: /goal log <id>");
        return;
      }
      await safeReply(ctx, "reply (/goal log)", renderGoalEvents(await readGoalEvents(arg, 20)));
      return;
    }

    await safeReply(ctx, "reply (/goal unknown)", "Unknown /goal command. Try /goal help.");
  } catch (err) {
    log.warn("goal command failed", { command: sub, err: err instanceof Error ? err.message : err });
    await safeReply(
      ctx,
      "reply (goal command failed)",
      `Goal command failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const goalCommands: CommandDef[] = [
  {
    name: "goal",
    description: "Manage long-running goals: start, list, status, pause, resume, next, log",
    category: "Goals",
    argsHint: "<subcommand> [args]",
    bypassLock: true,
    handler: (ctx, parsed) => handleGoal(ctx, parsed),
  },
];
