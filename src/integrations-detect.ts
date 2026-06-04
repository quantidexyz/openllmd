/**
 * Best-effort detection of which skills/plugins/setups are installed on THIS
 * box (the `claude-code` target footprint), reported on the daemon's status so
 * the dashboard can render a stateful Install vs ✓ installed / Uninstall
 * button. See `docs/proposals/daemon-integration-triggers.md` §7.
 *
 * Synchronous + self-healing: every read is guarded, an unreadable path simply
 * isn't reported (the dashboard then offers both Install + Uninstall, which is
 * safe — the scripts are idempotent). Coreless (node + schema types only).
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TDaemonInstalledIntegration } from "@openllm/schema";

/** Subdirectory names under `parent`, or `[]` if it doesn't exist. */
const listDirs = (parent: string): string[] => {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

const fileIncludes = (path: string, needle: string): boolean => {
  try {
    return readFileSync(path, "utf-8").includes(needle);
  } catch {
    return false;
  }
};

// `home` is injectable for tests — Bun caches `os.homedir()` within a process,
// so a fake `$HOME` can't be applied after boot. Production passes nothing.
export const detectInstalledIntegrations = (
  home: string = homedir(),
): TDaemonInstalledIntegration[] => {
  const out: TDaemonInstalledIntegration[] = [];
  const claudeDir = join(home, ".claude");

  // Skills: extracted to ~/.claude/skills/<slug>/.
  for (const slug of listDirs(join(claudeDir, "skills"))) {
    out.push({ kind: "skill", slug, installed: true });
  }
  // Plugins: extracted to ~/.claude/plugins/<slug>/.
  for (const slug of listDirs(join(claudeDir, "plugins"))) {
    out.push({ kind: "plugin", slug, installed: true });
  }

  // Setups — detected by the config footprint each install.sh writes.
  if (fileIncludes(join(claudeDir, "settings.json"), "ANTHROPIC_BASE_URL")) {
    out.push({ kind: "setup", slug: "claude-code", installed: true });
  }
  const codexDir = process.env.CODEX_HOME ?? join(home, ".codex");
  if (fileIncludes(join(codexDir, "config.toml"), "# >>> openllm")) {
    out.push({ kind: "setup", slug: "codex", installed: true });
  }
  const kimiDir = process.env.KIMI_CODE_HOME ?? join(home, ".kimi-code");
  if (fileIncludes(join(kimiDir, "config.toml"), "# >>> openllm")) {
    out.push({ kind: "setup", slug: "kimi-code", installed: true });
  }

  return out;
};
