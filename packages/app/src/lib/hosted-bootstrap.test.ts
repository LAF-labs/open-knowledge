import { describe, expect, test } from 'bun:test';
import { hostedClientFetchConfig } from './hosted-bootstrap';

describe('hostedClientFetchConfig', () => {
  test('keeps standalone behavior when no host bootstrap exists', () => {
    expect(hostedClientFetchConfig(undefined)).toEqual({});
    expect(hostedClientFetchConfig({})).toEqual({});
  });

  test('passes the host API prefix and fixed headers to the fetch seam', () => {
    expect(
      hostedClientFetchConfig({
        __OPEN_KNOWLEDGE_HOSTED__: {
          apiPrefix: '/api/open-knowledge',
          apiHeaders: { 'x-laf-workspace-slug': 'demo-team' },
        },
      }),
    ).toEqual({
      apiPrefix: '/api/open-knowledge',
      apiHeaders: { 'x-laf-workspace-slug': 'demo-team' },
    });
  });
});
