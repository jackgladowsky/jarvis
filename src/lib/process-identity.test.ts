import assert from "node:assert/strict";
import test from "node:test";
import { parseLinuxProcessStartTime, readProcessStartTime } from "./process-identity.js";

test("Linux process start time parsing tolerates spaces and parentheses in comm", async () => {
  const prefix = "123 (node worker (test)) S";
  const fieldsAfterState = Array.from({ length: 19 }, (_, index) => String(index + 1));
  // After state, starttime is the nineteenth numeric field (proc field 22).
  fieldsAfterState[18] = "987654321";
  assert.equal(parseLinuxProcessStartTime(`${prefix} ${fieldsAfterState.join(" ")}`), "987654321");
  if (process.platform === "linux") assert.match((await readProcessStartTime(process.pid)) ?? "", /^\d+$/);
});
