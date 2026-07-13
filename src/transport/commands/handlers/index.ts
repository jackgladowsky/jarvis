/**
 * Aggregates every command-group module into a single import surface and
 * registers them with the command registry at module-load time.
 */
import { registerCommands } from "../registry.js";
import { sessionCommands } from "./session.js";
import { statusCommands } from "./status.js";
import { modelCommands } from "./model.js";
import { sttBenchCommands } from "./sttbench.js";
import { helpCommands } from "./help.js";
import { backgroundCommands } from "./background.js";
import { goalCommands } from "./goal.js";
import { secretDropCommands } from "./secret-drop.js";

registerCommands([
  ...sessionCommands,
  ...statusCommands,
  ...modelCommands,
  ...sttBenchCommands,
  ...helpCommands,
  ...backgroundCommands,
  ...goalCommands,
  ...secretDropCommands,
]);

export {
  sessionCommands,
  statusCommands,
  modelCommands,
  sttBenchCommands,
  helpCommands,
  backgroundCommands,
  goalCommands,
  secretDropCommands,
};
