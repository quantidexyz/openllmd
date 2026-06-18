#!/usr/bin/env bun

/**
 * Compile the daemon into source-free standalone binaries.
 *
 * `bun build --compile` inlines the transitive workspace imports
 * (@quantidexyz/openllmw, @quantidexyz/openllmp, effect — NOT @openllm/core; the daemon
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
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { $ } from "bun";

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
// The daemon has ONE version identity: the app/manifest tag the release CLI
// passes via `--version` (commands/daemon.ts always passes it). There is no
// separate daemon version number — a source build with no `--version` (e.g.
// `bun daemon:build`) bakes the `"0.0.0-dev"` sentinel, which the runtime's
// dev guards (self-update / sandbox / service registration) key on to skip
// production behaviour. The vestigial `package.json` version was overwritten at
// build and only ever disagreed with the pin, so it is no longer read here.
const version =
  versionIdx >= 0 ? (argv[versionIdx + 1] ?? "0.0.0-dev") : "0.0.0-dev";

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
  // Emit a gzip sidecar for DISTRIBUTION. The embedded Bun runtime is most of
  // the ~100MB and compresses ~66%, so the published GitHub asset is the `.gz`
  // (faster upload, less org storage). The release pins the sha256 of the
  // DECOMPRESSED binary, and install.sh + self-update decompress before
  // verifying — so the integrity gate is independent of gzip's
  // non-determinism. The raw binary stays for local runs + the sha source.
  writeFileSync(`${outfile}.gz`, gzipSync(readFileSync(outfile), { level: 9 }));
  return outfile;
};

const main = async (): Promise<void> => {
  await $`mkdir -p ${OUT_DIR}`;
  if (hostOnly) {
    const out = await buildOne(null);
    console.log(`built host binary → ${out}`);
    return;
  }
  // Build all four targets IN PARALLEL. Each `bun build --compile` is an
  // independent cross-compile writing its own `--outfile`, so there's no
  // shared state — running them concurrently turns ~4× sequential wall-time
  // into roughly one build's worth (the previous sequential loop is why a
  // release "took ages"). Logs land as each finishes.
  const t0 = Date.now();
  await Promise.all(
    TARGETS.map(async (target) => {
      const out = await buildOne(target);
      console.log(`built ${target} → ${out}`);
    }),
  );
  console.log(`compiled ${TARGETS.length} targets in ${Date.now() - t0}ms`);
};

await main();
