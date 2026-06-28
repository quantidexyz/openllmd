/**
 * Shared filesystem-path helpers for the daemon.
 */
import { homedir } from "node:os";

/**
 * Standard user bin dirs the daemon prepends to a spawned integration's PATH.
 * The daemon runs as a background service with a minimal inherited PATH, so
 * user-installed CLIs the bundled scripts call (`claude` lands in ~/.local/bin;
 * `bun` lands in ~/.bun/bin via the official installer; many tools live under
 * Homebrew) aren't found and a script that relies on one half-applies or acks
 * `status:error`. Every entry is within the OS-sandbox working set (`/opt`,
 * `/usr`, ~/.local/bin, ~/.bun — see `sandbox/working-set.ts`), so a spawn never
 * hits a Landlock denial; absent dirs are simply ignored by the shell. Evaluated
 * once at module load (`homedir()` is stable for the process).
 */
export const DEFAULT_BIN_DIRS: readonly string[] = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  `${homedir()}/.local/bin`,
  `${homedir()}/.bun/bin`,
];
