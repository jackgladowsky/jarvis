/**
 * STT benchmark trigger: `/sttbench`.
 */
import type { Context } from "grammy";
import { markSttBenchmarkNext } from "./state.js";
import type { CommandDef } from "../registry.js";

export async function handleSttBench(ctx: Context): Promise<void> {
  const chatId = ctx.chat!.id;
  markSttBenchmarkNext(chatId);
  await ctx.reply(
    "Send one voice note/audio file next; I’ll run base.en and small.en in parallel and report transcripts/timings.",
  );
}

export const sttBenchCommands: CommandDef[] = [
  {
    name: "sttbench",
    description: "Benchmark local Whisper base.en + small.en on next voice note",
    category: "Diagnostics",
    handler: (ctx) => handleSttBench(ctx),
  },
];
