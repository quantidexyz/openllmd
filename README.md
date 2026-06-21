<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="./assets/openllm-light.svg">
    <img alt="OpenLLM" src="./assets/openllm.svg" width="300">
  </picture>
</p>

<p align="center"><b>openllmd</b> — the local OpenLLM daemon.</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: BUSL-1.1" src="https://img.shields.io/badge/license-BUSL--1.1-blue.svg"></a>
  <img alt="source-available" src="https://img.shields.io/badge/source-available-informational.svg">
  <img alt="targets" src="https://img.shields.io/badge/targets-darwin%20%C2%B7%20linux%20(arm64%2Fx64)-lightgrey.svg">
</p>

---

A small headless program that serves the **subscription** providers
(`claude_code`, `chatgpt`, `kimi_code`) **on your machine** — by delegating
to each vendor's **official CLI** using that CLI's own credentials and
identity. A subscription token never touches OpenLLM's servers, and nothing
is forged.

It dials out to the cloud over your API key; the dashboard drives it
(status · connect · install) through that channel — no browser→localhost.
API-key (BYOK) providers keep running on the hosted gateway; only
subscription chains need the daemon.

Coreless by construction: links only
[`@quantidexyz/openllmw`](https://github.com/quantidexyz/openllmw) +
[`@quantidexyz/openllmp`](https://github.com/quantidexyz/openllmp) — never the
proprietary cloud pipeline.

## Install

The canonical distribution is the **compiled binary** (verified against its
published SHA-256):

```sh
curl -fsSL https://openllm.sh/api/daemon/binary/install.sh | sh -s -- --key sk-llm-…
openllmd start        # auto-restarts on crash, survives reboot
openllmd status
```

Or consume the source as a package:

```sh
bun install github:quantidexyz/openllmd # latest
```

## Verify

Every published binary is pinned by SHA-256 in [`manifest.ts`](./manifest.ts),
committed to this repo. Confirm the artifacts the cloud serves are exactly what
this source vouches for — no trust required:

```sh
bun install
bun run verify                       # download every published target, hash it, check vs manifest.ts
bun run verify -- --host             # just this machine's target
bun run verify -- --file ./openllmd  # a binary you already installed/downloaded
bun run verify -- --installed        # the `openllmd` on your $PATH
```

Exit code is `0` only when every checked binary matches its pinned digest.

> Note: the binary is **not** byte-reproducible (`bun build --compile
> --bytecode` embeds non-deterministic bytecode), so rebuilding from source
> won't hash-match the release. The verifiable guarantee is that the
> **published** asset matches the SHA-256 committed here — the same digest
> `install.sh` and the daemon's self-update enforce on download.

## License

**Source-available** under the [Business Source License 1.1](./LICENSE)
(© Quantide LLC) — converts to MIT on the Change Date. Not OSI open-source.

---

> **Read-only mirror.** Regenerated from the OpenLLM monorepo each release.
> PRs welcome — ingested upstream with your authorship preserved. BUSL
> contributions require the CLA (the bot will prompt you).
