#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
/**
 * Publish the daemon binaries as GitHub Release assets and pin them in the
 * committed manifest (`packages/daemon/release.ts`).
 *
 * This is intentionally DECOUPLED from the Vercel build — compiling four
 * `bun --compile` targets per deploy was too slow/heavy. Run it by hand (or in
 * CI) when the daemon changes; the cloud's /api/daemon/binary route just
 * redirects to the asset for the pinned tag.
 *
 * Steps: compile all targets → sha256 each → create/refresh the GitHub release
 * on the release repo with the binaries attached → rewrite release.ts with the
 * tag + checksums. Then COMMIT release.ts and deploy.
 *
 * Versioning: with no version flag the current root `package.json` version is
 * reused. `--bump <major|minor|patch|prerelease>` computes the next semver,
 * writes it back to `package.json` (so the compiled binary embeds it), and
 * tags the release with it. `--preid <id>` (default `alpha`) names a new
 * prerelease line. `--tag`/`--version` pin an explicit value (no bump/write).
 *
 * Usage:
 *   bun packages/daemon/scripts/release.ts                 # tag = v<pkg.version>
 *   bun packages/daemon/scripts/release.ts --bump patch    # 1.3.1 → write + tag
 *   bun packages/daemon/scripts/release.ts --bump prerelease           # alpha.0 → alpha.1
 *   bun packages/daemon/scripts/release.ts --bump prerelease --preid beta
 *   bun packages/daemon/scripts/release.ts --tag v1.2.3    # explicit, no write
 *   bun packages/daemon/scripts/release.ts --no-compile    # reuse existing dist
 *   bun packages/daemon/scripts/release.ts --draft
 *
 * Release repo defaults to `quantidexyz/openllmd`; override with
 * OPENLLM_DAEMON_RELEASE_REPO. Requires the `gh` CLI authenticated with push
 * access to that repo (the repo must already exist).
 */
import { $ } from "bun";
import rootPkg from "../../../package.json" with { type: "json" };

const REPO = process.env.OPENLLM_DAEMON_RELEASE_REPO ?? "quantidexyz/openllmd";
const TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
] as const;
const DIST = "packages/daemon/dist";
const MANIFEST = "packages/daemon/release.ts";
const ROOT_PKG = "package.json";

const BUMPS = ["major", "minor", "patch", "prerelease"] as const;
type TBump = (typeof BUMPS)[number];

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const skipCompile = argv.includes("--no-compile");
const draft = argv.includes("--draft");

/** Compute the next semver from `current`. Mirrors npm-version semantics. */
const bumpVersion = (current: string, kind: TBump, preid: string): string => {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)\.(\d+))?$/);
  if (!m) throw new Error(`Cannot parse version "${current}"`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const preName = m[4];
  const preNum = m[5];
  switch (kind) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      // Finalize an in-flight prerelease, else bump the patch.
      return preName !== undefined
        ? `${major}.${minor}.${patch}`
        : `${major}.${minor}.${patch + 1}`;
    case "prerelease":
      return preName !== undefined && preNum !== undefined
        ? `${major}.${minor}.${patch}-${preName}.${Number(preNum) + 1}`
        : `${major}.${minor}.${patch + 1}-${preid}.0`;
  }
};

/** Rewrite the root package.json `version` in place (text-preserving). */
const setRootVersion = async (next: string): Promise<void> => {
  const text = await readFile(ROOT_PKG, "utf-8");
  const updated = text.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`);
  if (updated === text) {
    throw new Error("Could not find a version field to update in package.json");
  }
  await writeFile(ROOT_PKG, updated, "utf-8");
};

// Resolve the target version + whether we mutate package.json.
const explicitTag = flag("--tag");
const explicitVersion = flag("--version");
const bumpKind = flag("--bump");
const preid = flag("--preid") ?? "alpha";

if (bumpKind !== undefined && !BUMPS.includes(bumpKind as TBump)) {
  console.error(`--bump must be one of: ${BUMPS.join(" | ")}`);
  process.exit(1);
}

let version: string;
let bumped = false;
if (explicitTag !== undefined) {
  version = explicitTag.replace(/^v/, "");
} else if (explicitVersion !== undefined) {
  version = explicitVersion.replace(/^v/, "");
} else if (bumpKind !== undefined) {
  version = bumpVersion(rootPkg.version, bumpKind as TBump, preid);
  bumped = true;
} else {
  version = rootPkg.version;
}
const tag = `v${version}`;

const sha256 = async (file: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

const manifestSource = (sha: Record<string, string>): string => {
  const shaBody = TARGETS.map(
    (t) => `    ${JSON.stringify(t)}: ${JSON.stringify(sha[t])},`,
  ).join("\n");
  const targets = TARGETS.map((t) => JSON.stringify(t)).join(", ");
  return `// AUTOGENERATED by packages/daemon/scripts/release.ts — DO NOT EDIT BY HAND.
// COMMITTED on purpose (unlike the gitignored bundle outputs): this pins the
// published daemon release that the cloud's /api/daemon/binary route redirects
// to. Re-run \`bun packages/daemon/scripts/release.ts\`, then commit this file.
//
// \`tag: ""\` means nothing is published yet — the route returns 503 until the
// first release script run fills in the tag + checksums.

import type { TDaemonRelease } from "./release-types";

export const DAEMON_RELEASE: TDaemonRelease = {
  repo: ${JSON.stringify(REPO)},
  tag: ${JSON.stringify(tag)},
  targets: [${targets}],
  sha256: {
${shaBody}
  },
};
`;
};

const main = async (): Promise<void> => {
  // Preflight: the release repo must exist + be pushable.
  const repoOk = await $`gh repo view ${REPO}`.nothrow().quiet();
  if (repoOk.exitCode !== 0) {
    console.error(
      `Release repo ${REPO} not reachable. Create it first:\n  gh repo create ${REPO} --public\n(or set OPENLLM_DAEMON_RELEASE_REPO).`,
    );
    process.exit(1);
  }

  if (bumped) {
    console.log(`Bumping version ${rootPkg.version} → ${version}`);
    await setRootVersion(version);
  }

  if (!skipCompile) {
    console.log(`Compiling daemon binaries for ${tag}...`);
    await $`bun packages/daemon/scripts/compile.ts --version ${version}`;
  }

  const files = TARGETS.map((t) => `${DIST}/openllmd-${t}`);
  const sha: Record<string, string> = {};
  for (const t of TARGETS) sha[t] = await sha256(`${DIST}/openllmd-${t}`);

  const exists =
    (await $`gh release view ${tag} -R ${REPO}`.nothrow().quiet()).exitCode ===
    0;
  if (exists) {
    console.log(
      `Release ${tag} exists on ${REPO} — uploading assets (--clobber).`,
    );
    await $`gh release upload ${tag} ${files} -R ${REPO} --clobber`;
  } else {
    console.log(`Creating release ${tag} on ${REPO}...`);
    const draftFlag = draft ? ["--draft"] : [];
    await $`gh release create ${tag} ${files} -R ${REPO} --title ${`openllmd ${tag}`} --notes ${`openllmd ${tag}`} ${draftFlag}`;
  }

  await writeFile(MANIFEST, manifestSource(sha), "utf-8");
  const toCommit = bumped ? `${ROOT_PKG} ${MANIFEST}` : MANIFEST;
  console.log(
    `\nWrote ${MANIFEST}${bumped ? ` + ${ROOT_PKG}` : ""}. Commit + deploy:`,
  );
  console.log(
    `  git add ${toCommit} && git commit -m "release: openllmd ${tag}"`,
  );
};

await main();
