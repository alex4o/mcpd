import bunLogger from "bun-logger";
import { findProjectRoot } from "./config.ts";
import { join } from "path";

const LOG_FILE = join(findProjectRoot(), "mcpd.log");

const log = bunLogger({
  name: "mcpd",
  level: "trace",
  format: "json",
  destination: { path: LOG_FILE },
});

export default log;
