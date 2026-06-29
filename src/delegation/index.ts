import { chatgptDelegate } from "./chatgpt";
import { claudeCodeDelegate } from "./claude-code";
import { grokDelegate } from "./grok";
import { kimiCodeDelegate } from "./kimi-code";
import type { TProviderDelegate } from "./types";

export type { TProviderDelegate } from "./types";

/**
 * The subscription provider slugs the daemon serves locally. These are
 * exactly the `authKind: "oauth"` providers the cloud refuses
 * server-side (`packages/core/providers/registry.ts`).
 */
export const DELEGATES: Readonly<Record<string, TProviderDelegate>> = {
  claude_code: claudeCodeDelegate,
  chatgpt: chatgptDelegate,
  kimi_code: kimiCodeDelegate,
  grok: grokDelegate,
};

export const isSubscriptionSlug = (slug: string): boolean =>
  Object.hasOwn(DELEGATES, slug);

export const getDelegate = (slug: string): TProviderDelegate | null =>
  DELEGATES[slug] ?? null;
