import type { StatusMode } from "../agent/runtime.js";

export function parseModeCommand(text: string): { command: "thinking" | "verbose"; arg: string } | undefined {
  const [rawCommand, rawArg = ""] = text.trim().split(/\s+/, 2);
  const command = rawCommand.replace(/^\//, "").split("@")[0];
  if (command !== "thinking" && command !== "verbose") return undefined;
  return { command, arg: rawArg.toLowerCase() };
}

export function nextStatusMode(command: "thinking" | "verbose", arg: string): StatusMode | undefined {
  if (["off", "false", "0", "stop"].includes(arg)) return "off";
  if (["on", "true", "1", ""].includes(arg)) return command === "verbose" ? "verbose" : "thinking";
  return undefined;
}

export function commandName(text: string): string {
  return text.trim().split(/\s+/, 1)[0]?.replace(/^\//, "").split("@")[0] ?? "";
}

export function commandRest(text: string): string {
  const trimmed = text.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
}
