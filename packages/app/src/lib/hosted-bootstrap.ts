import type { installClientFetchWrapper } from './client-fetch';

type ClientFetchConfig = NonNullable<Parameters<typeof installClientFetchWrapper>[0]>;

export interface OpenKnowledgeHostedBootstrap {
  apiPrefix?: string;
  apiHeaders?: Record<string, string>;
}

declare global {
  interface Window {
    __OPEN_KNOWLEDGE_HOSTED__?: OpenKnowledgeHostedBootstrap;
  }
}

/** Read the optional host-injected transport seam without changing standalone defaults. */
export function hostedClientFetchConfig(
  windowLike: Pick<Window, '__OPEN_KNOWLEDGE_HOSTED__'> | undefined = typeof window === 'undefined'
    ? undefined
    : window,
): ClientFetchConfig {
  const hosted = windowLike?.__OPEN_KNOWLEDGE_HOSTED__;
  if (!hosted) return {};
  return {
    apiPrefix: hosted.apiPrefix,
    apiHeaders: hosted.apiHeaders,
  };
}
