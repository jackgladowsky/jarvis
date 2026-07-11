#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { CURRENT_CONFIG_SCHEMA_VERSION, parseConfig } from "./config-schema.js";

const file = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: config-check <config.yaml>");
  process.exitCode = 2;
} else {
  try {
    const parsed = parseConfig(parseYaml(await readFile(file, "utf-8")), file);
    console.log(`config valid: ${file} (schema v${parsed.schema_version}/${CURRENT_CONFIG_SCHEMA_VERSION})`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
