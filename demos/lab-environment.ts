// The Lab's first-run environment: a real generated toolchain, so a new user has something true to
// look at before they have pointed EXAPT at anything of their own.
import path from "node:path";
import fs from "node:fs";
import { writeEnvironment } from "./missing-transformation/environment.ts";
import type { Goal } from "../packages/capability-universe/index.ts";

export function prepareLabEnvironment(seed = 16): { programs: string; entry: { id: string; title: string; goal: Goal; base: string } } {
  const dir = path.join(process.env.EXAPT_HOME ?? path.join(process.cwd(), ".exapt"), "lab-environment", `seed-${seed}`);
  fs.mkdirSync(dir, { recursive: true });
  const env = writeEnvironment(seed, fs.realpathSync(dir));
  return { programs: env.programs, entry: { id: env.goal.id, title: env.goal.intent, goal: env.goal, base: env.base } };
}
