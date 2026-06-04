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
 * reused. `--bump <major|minor|patch|prerelease>` computes the next semver and
 * writes it back to the root `package.json`. `--preid <id>` (default `alpha`)
 * names a new prerelease line. `--tag`/`--version` pin an explicit value (no
 * bump). Either way the resolved version is stamped into the daemon's OWN
 * `packages/daemon/package.json` BEFORE compiling, so the binary + package
 * both carry it.
 *
 * Overwrite: by default the script REFUSES to touch an already-published
 * version (protects real releases). Pass `--overwrite` to replace it in place
 * (clobber the same tag's assets) — the dev workflow, so trial builds reuse
 * one version instead of flooding the releases page + git tags.
 *
 * Parent commit: by default the script only PRINTS the `git add … && commit`
 * line for the manifest, leaving the parent repo for you to commit by hand.
 * `--commit-parent` automates that in the CORRECT ORDER — the daemon binaries
 * are already published + the manifest pinned (a failure above aborted before
 * this point), so the commit captures a manifest that points at assets that
 * exist. It stages the release artifacts (manifest + package.json) AND every
 * other already-modified TRACKED file, so a parent-app change that must deploy
 * alongside the manifest (e.g. an updated `install.sh`) rides in the same
 * commit. This is NOT a parent version-bump release (no parent tag / GitHub
 * release) — it's a plain commit; that's the inverse of the parent script's
 * `--with-daemon`. Add `--push` to push the current branch (triggers the
 * Vercel deploy) instead of leaving it staged locally.
 *
 * Usage:
 *   bun packages/daemon/scripts/release.ts                 # tag = v<pkg.version>
 *   bun packages/daemon/scripts/release.ts --overwrite     # re-release same version
 *   bun packages/daemon/scripts/release.ts --bump patch    # 1.3.1 → write + tag
 *   bun packages/daemon/scripts/release.ts --bump prerelease           # alpha.0 → alpha.1
 *   bun packages/daemon/scripts/release.ts --bump prerelease --preid beta
 *   bun packages/daemon/scripts/release.ts --tag v1.2.3    # explicit version
 *   bun packages/daemon/scripts/release.ts --no-compile    # reuse existing dist
 *   bun packages/daemon/scripts/release.ts --overwrite --commit-parent --push
 *                                                          # re-release + commit
 *                                                          # parent + deploy
 *   bun packages/daemon/scripts/release.ts --draft
 *
 * Release repo defaults to `quantidexyz/openllmd`; override with
 * OPENLLM_DAEMON_RELEASE_REPO. Requires the `gh` CLI authenticated with push
 * access to that repo (the repo must already exist).
 */
import { $ } from "bun";
import rootPkg from "../../../package.json" with { type: "json" };
import { DAEMON_TARGETS } from "../release-types";

const REPO = process.env.OPENLLM_DAEMON_RELEASE_REPO ?? "quantidexyz/openllmd";
// Single source of truth (packages/daemon/release-types.ts) — don't re-declare.
const TARGETS = DAEMON_TARGETS;
const DIST = "packages/daemon/dist";
const MANIFEST = "packages/daemon/release.ts";
const ROOT_PKG = "package.json";
const DAEMON_PKG = "packages/daemon/package.json";

const BUMPS = ["major", "minor", "patch", "prerelease"] as const;
type TBump = (typeof BUMPS)[number];

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const skipCompile = argv.includes("--no-compile");
const draft = argv.includes("--draft");
// Commit the parent repo after the daemon is published + the manifest pinned
// (correct order). Without it the script just prints the commit command, as
// before. `--push` additionally pushes the current branch (Vercel deploy).
const commitParent = argv.includes("--commit-parent");
const pushParent = argv.includes("--push");
// Re-release an EXISTING version in place (clobber its assets) instead of
// erroring. Dev workflow: keep overwriting one trial version rather than
// minting a new tag + release per build (which floods the releases page and
// piles up git tags). Real releases are protected without this flag.
const overwrite = argv.includes("--overwrite");

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
      // Continue the SAME prerelease channel only when --preid matches it;
      // a different --preid starts a fresh channel on the current version,
      // and a release version starts one on the next patch.
      if (preName === preid && preNum !== undefined) {
        return `${major}.${minor}.${patch}-${preName}.${Number(preNum) + 1}`;
      }
      return preName !== undefined
        ? `${major}.${minor}.${patch}-${preid}.0`
        : `${major}.${minor}.${patch + 1}-${preid}.0`;
  }
};

const VERSION_RE = /("version":\s*")[^"]+(")/;

/** Rewrite a package.json `version` in place (text-preserving). No-op if it's
 *  already `next`; throws only when the file has no version field at all. */
const setPkgVersion = async (pkgPath: string, next: string): Promise<void> => {
  const text = await readFile(pkgPath, "utf-8");
  if (!VERSION_RE.test(text)) {
    throw new Error(`No version field to update in ${pkgPath}`);
  }
  const updated = text.replace(VERSION_RE, `$1${next}$2`);
  if (updated !== text) await writeFile(pkgPath, updated, "utf-8");
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

  // Refuse to clobber an existing release unless asked — and check BEFORE the
  // (slow) compile so a duplicate-version run fails fast.
  const exists =
    (await $`gh release view ${tag} -R ${REPO}`.nothrow().quiet()).exitCode ===
    0;
  if (exists && !overwrite) {
    console.error(
      `Release ${tag} already exists on ${REPO}.\n` +
        `Re-run with --overwrite to replace it in place, or bump the version (--bump …).`,
    );
    process.exit(1);
  }

  // Stamp the version BEFORE compiling so the binary embeds it. The daemon's
  // own package.json is always synced to the released version; the root
  // package.json is moved too when this run bumped it.
  if (bumped) {
    console.log(`Bumping root version ${rootPkg.version} → ${version}`);
    await setPkgVersion(ROOT_PKG, version);
  }
  await setPkgVersion(DAEMON_PKG, version);

  if (!skipCompile) {
    console.log(`Compiling daemon binaries for ${tag}...`);
    await $`bun packages/daemon/scripts/compile.ts --version ${version}`;
  }

  const files = TARGETS.map((t) => `${DIST}/openllmd-${t}`);
  const sha: Record<string, string> = {};
  for (const t of TARGETS) sha[t] = await sha256(`${DIST}/openllmd-${t}`);

  // A `-pre.N` version is a prerelease — don't mark it "Latest".
  const isPre = version.includes("-");
  if (exists) {
    console.log(
      `Overwriting release ${tag} on ${REPO} (clobbering assets, same tag)…`,
    );
    await $`gh release upload ${tag} ${files} -R ${REPO} --clobber`;
    await $`gh release edit ${tag} -R ${REPO} --prerelease=${String(isPre)}`.nothrow();
  } else {
    console.log(`Creating release ${tag} on ${REPO}...`);
    const flags = [
      ...(draft ? ["--draft"] : []),
      ...(isPre ? ["--prerelease"] : []),
    ];
    await $`gh release create ${tag} ${files} -R ${REPO} --title ${`openllmd ${tag}`} --notes ${`openllmd ${tag}`} ${flags}`;
  }

  await writeFile(MANIFEST, manifestSource(sha), "utf-8");
  // The manifest is COMMITTED, so it must pass `biome check`. Its sha256 lines
  // exceed the line width; let biome wrap them rather than hand-matching its
  // formatter. Best-effort — a missing biome shouldn't fail the release.
  await $`bunx biome format --write ${MANIFEST}`.nothrow().quiet();

  // The release artifacts the commit must include. Root package.json only when
  // this run bumped it; the daemon package.json + manifest always.
  const artifacts = [...(bumped ? [ROOT_PKG] : []), DAEMON_PKG, MANIFEST];

  if (!commitParent) {
    console.log(`\nWrote ${MANIFEST} + ${DAEMON_PKG}. Commit + deploy:`);
    console.log(
      `  git add ${artifacts.join(" ")} && git commit -m "release: openllmd ${tag}"`,
    );
    return;
  }

  // --commit-parent: the binaries are published + the manifest is pinned, so
  // committing the parent now is the correct order. Stage the artifacts
  // explicitly, then `git add -u` to fold in every OTHER already-modified
  // TRACKED file (the parent-app change that ships alongside the manifest —
  // e.g. install.sh). `-u` is tracked-only, so it never sweeps stray untracked
  // files. Print the staged set first so the commit's contents are visible.
  await $`git add ${artifacts}`;
  await $`git add -u`;
  const staged = (await $`git diff --cached --name-only`.quiet()).stdout
    .toString()
    .trim();
  if (staged.length === 0) {
    console.log("\nNothing to commit — working tree already clean.");
    return;
  }
  console.log(`\nCommitting parent (chore(release): openllmd ${tag}):`);
  for (const f of staged.split("\n")) console.log(`  + ${f}`);
  await $`git commit -m ${`chore(release): openllmd ${tag}`}`;

  if (!pushParent) {
    console.log("\n✓ Committed. Push when ready (or re-run with --push):");
    const branch = (await $`git rev-parse --abbrev-ref HEAD`.quiet()).stdout
      .toString()
      .trim();
    console.log(`  git push origin ${branch}`);
    return;
  }

  const branch = (await $`git rev-parse --abbrev-ref HEAD`.quiet()).stdout
    .toString()
    .trim();
  console.log(`\n→ Pushing ${branch} (triggers the Vercel deploy)…`);
  await $`git push origin ${branch}`;
  console.log(`✓ Pushed ${branch}.`);
};

await main();
