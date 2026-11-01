import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configFromEnv, Exapt, type ExaptConfig } from "../packages/protocol/engine.ts";
import { dockerStatus } from "../packages/execution/index.ts";

export const dockerReady = dockerStatus().imagePresent;
export const sandboxSkip = dockerReady ? false : "needs Docker and the pinned image";

export const tempDir = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `exapt-test-${name}-`)));

export function program(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2);\n${body}\n`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

export function engine(dir: string, programs: string[], extra: Partial<ExaptConfig> = {}): Promise<Exapt> {
  return Exapt.open(configFromEnv({}, { home: path.join(dir, ".exapt"), programs, model: null, ...extra }));
}

export const hasBinary = (b: string): boolean => spawnSync("which", [b]).status === 0;
