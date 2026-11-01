// Reproduce the upstream baseline: fetch the pinned RightClick X commit, confirm every vendored file
// matches it, and run upstream's own test suite there.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../packages/shared/index.ts";

const root = path.join(import.meta.dirname, "../vendor/rightclick-x");
const upstream = JSON.parse(fs.readFileSync(path.join(root, "UPSTREAM.json"), "utf8")) as { repository: string; commit: string; files: Record<string, string> };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exapt-upstream-"));
const run = (cmd: string, args: string[], cwd = dir) => spawnSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
if (run("git", ["clone", "--quiet", upstream.repository, "."]).status !== 0 || run("git", ["checkout", "--quiet", upstream.commit]).status !== 0) process.exit(1);
const different = Object.entries(upstream.files).filter(([f, h]) => sha256(fs.readFileSync(path.join(dir, f))) !== h);
console.log(`${Object.keys(upstream.files).length - different.length}/${Object.keys(upstream.files).length} vendored files match ${upstream.commit.slice(0, 7)}`);
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
const tests = spawnSync(process.execPath, ["--test", "--test-concurrency=4", "--test-timeout=120000", ...fs.readdirSync(path.join(dir, "test")).filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`), "experiments/inheritance/guards.test.ts"], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
console.log(tests.stdout.split("\n").filter((l) => /^ℹ (tests|pass|fail)/.test(l)).join("\n"));
process.exit(different.length || tests.status ? 1 : 0);
