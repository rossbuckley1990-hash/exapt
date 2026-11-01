// `exapt demo`: demonstrations of the generic capability engine.
import { demo1 } from "./missing-transformation/run.ts";
import { demo2 } from "./digital-resurrection/run.ts";
import { demo3 } from "./inherited-superpower/run.ts";
import { demo4 } from "./invariant-telemetry/run.ts";
import { dockerStatus } from "../packages/execution/index.ts";
import { modelFromEnv } from "../packages/model-adapters/index.ts";

export async function runDemos(which: string, opts: { seed?: number }): Promise<number> {
  const docker = dockerStatus();
  if (!docker.available || !docker.imagePresent) {
    console.error(`Generated code cannot run here: ${docker.detail}.\nnext: ${docker.available ? "npm run setup" : "install and start Docker"}. EXAPT refuses to run generated code without containment.`);
    return 3;
  }
  const model = modelFromEnv();
  console.log(model ? `Model configured: ${model.provider}/${model.model}. Candidates it writes are labelled as model synthesis.` : "No model configured. Everything below is DETERMINISTIC synthesis: a search over a small expression language and a binary layout inducer. No model is involved, and no answer is stored.");
  const results: boolean[] = [];
  if (which === "1" || which === "all") results.push((await demo1(opts)).ok);
  if (which === "2" || which === "all") results.push((await demo2(opts)).ok);
  if (which === "3" || which === "all") results.push((await demo3(opts)).ok);
  if (which === "4" || which === "telemetry" || which === "all") results.push((await demo4(opts)).ok);
  return results.every(Boolean) ? 0 : 1;
}
