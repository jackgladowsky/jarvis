import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import {
  cancelDynamicTask,
  createDynamicTask,
  listDynamicTasks,
  snoozeDynamicTask,
  updateDynamicTask,
} from "../../scheduler-service.js";
import { withToolAudit } from "./audited.js";

const schema = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("list"),
    Type.Literal("update"),
    Type.Literal("snooze"),
    Type.Literal("cancel"),
  ]),
  id: Type.Optional(Type.String()),
  name: Type.Optional(Type.String({ maxLength: 200 })),
  prompt: Type.Optional(Type.String({ maxLength: 20_000 })),
  when: Type.Optional(
    Type.String({
      description:
        "Strict ISO timestamp with offset, in N minutes/hours/days, tomorrow at HH[:MM], or [next] weekday at HH[:MM].",
    }),
  ),
  recurrence: Type.Optional(
    Type.String({
      description: "Validated five-field cron or a supported phrase such as daily at 09:00 or every weekday at 08:30.",
    }),
  ),
  timezone: Type.Optional(
    Type.String({ description: "IANA timezone. Defaults to the configured scheduler timezone." }),
  ),
  notify: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("on_issue"), Type.Literal("never")])),
  expected_revision: Type.Optional(Type.Number()),
  idempotency_key: Type.Optional(Type.String({ maxLength: 200 })),
  include_terminal: Type.Optional(Type.Boolean()),
});
function render(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
const rawSchedulerControlTool: AgentTool<typeof schema> = {
  name: "scheduler_control",
  label: "scheduler_control",
  description:
    "Create, list, update, snooze, or cancel reminders and recurring automations from natural-language requests. Use this instead of editing tasks.json. Time parsing is intentionally strict and rejects ambiguity. For safe retries, provide a stable idempotency_key on create and mutation calls; use expected_revision from list results when changing an existing task.",
  parameters: schema,
  async execute(_id, args) {
    if (args.action === "list") {
      const tasks = await listDynamicTasks({ includeTerminal: args.include_terminal });
      return {
        content: [
          { type: "text", text: render({ timezone_note: "Each task includes its effective IANA timezone.", tasks }) },
        ],
        details: { tasks },
      };
    }
    if (args.action === "create") {
      if (!args.name || !args.prompt) throw new Error("name and prompt are required for create");
      const result = await createDynamicTask({
        id: args.id,
        name: args.name,
        prompt: args.prompt,
        when: args.when,
        recurrence: args.recurrence,
        timezone: args.timezone,
        notify: args.notify,
        idempotencyKey: args.idempotency_key,
      });
      return { content: [{ type: "text", text: render(result) }], details: result };
    }
    if (!args.id) throw new Error("id is required for update, snooze, and cancel");
    if (args.action === "snooze") {
      if (!args.when) throw new Error("when is required for snooze");
      const task = await snoozeDynamicTask(args.id, args.when, args.expected_revision, args.idempotency_key);
      return { content: [{ type: "text", text: render({ task }) }], details: { task } };
    }
    if (args.action === "cancel") {
      const task = await cancelDynamicTask(args.id, args.expected_revision, args.idempotency_key);
      return { content: [{ type: "text", text: render({ task }) }], details: { task } };
    }
    const task = await updateDynamicTask({
      id: args.id,
      expectedRevision: args.expected_revision,
      mutationKey: args.idempotency_key,
      name: args.name,
      prompt: args.prompt,
      when: args.when,
      recurrence: args.recurrence,
      timezone: args.timezone,
      notify: args.notify,
    });
    return { content: [{ type: "text", text: render({ task }) }], details: { task } };
  },
};
export const schedulerControlTool = withToolAudit(rawSchedulerControlTool, {
  summarizeArgs: (args) => ({
    action: args.action,
    id: args.id,
    timezone: args.timezone,
    notify: args.notify,
    has_when: Boolean(args.when),
    has_recurrence: Boolean(args.recurrence),
    has_prompt: Boolean(args.prompt),
    has_idempotency_key: Boolean(args.idempotency_key),
    expected_revision: args.expected_revision,
  }),
  summarizeError: () => "scheduler control operation failed",
});
