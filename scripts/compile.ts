#!/usr/bin/env bun

/**
 * Compile the daemon into source-free standalone binaries.
 *
 * `bun build --compile` inlines the transitive workspace imports
 * (@openllm/wire, @openllm/schema, effect — NOT @openllm/core; the daemon
 * is coreless) following the symlinks Bun creates for `workspace:*` deps,
 * into a single executable that embeds the Bun runtime. `--minify
 * --bytecode` strips readable identifiers + original source text. No `.ts`
 * source ships. (The binary is runtime-dominated; the coreless win is not
 * shipping the proprietary pipeline + decoupling the daemon's release
 * cadence from `core`, not raw bytes.)
 *
 * Targets (no Windows): darwin-{arm64,x64}, linux-{x64,arm64}.
 *
 * Usage:
 *   bun run packages/daemon/scripts/compile.ts            # all targets
 *   bun run packages/daemon/scripts/compile.ts --host     # current host only
 *   bun run packages/daemon/scripts/compile.ts --version 1.2.3
 */
import { $ } from "bun";
import rootPkg from "../../../package.json" with { type: "json" };

const ENTRY = "packages/daemon/src/main.ts";
const OUT_DIR = "packages/daemon/dist";
const CLOUD_ORIGIN = process.env.OPENLLM_CLOUD_ORIGIN ?? "https://openllm.sh";

const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

const argv = process.argv.slice(2);
const hostOnly = argv.includes("--host");
const versionIdx = argv.indexOf("--version");
// Default to the repo's release version so every binary carries a real,
// release-tracking version (surfaced in `/status` + bumped per release) —
// this is how a mixed fleet is told apart, e.g. an old core-backed daemon
// vs this coreless one (proposal §7.5). `--version` overrides for one-offs.
const version =
  versionIdx >= 0 ? (argv[versionIdx + 1] ?? rootPkg.version) : rootPkg.version;

const outfileFor = (target: string): string => {
  const suffix = target.replace(/^bun-/, "");
  return `${OUT_DIR}/openllmd-${suffix}`;
};

const buildOne = async (target: string | null): Promise<string> => {
  const outfile = target === null ? `${OUT_DIR}/openllmd` : outfileFor(target);
  const targetArgs = target === null ? [] : ["--target", target];
  await $`bun build ${ENTRY} \
    --compile \
    --minify \
    --sourcemap=none \
    --bytecode \
    --define ${`__OPENLLM_CLOUD_ORIGIN_DEFAULT__=${JSON.stringify(CLOUD_ORIGIN)}`} \
    --define ${`__OPENLLM_DAEMON_VERSION__=${JSON.stringify(version)}`} \
    ${targetArgs} \
    --outfile ${outfile}`;
  return outfile;
};

const main = async (): Promise<void> => {
  await $`mkdir -p ${OUT_DIR}`;
  if (hostOnly) {
    const out = await buildOne(null);
    console.log(`built host binary → ${out}`);
    return;
  }
  for (const target of TARGETS) {
    const out = await buildOne(target);
    console.log(`built ${target} → ${out}`);
  }
};

await main();
