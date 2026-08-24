import { describe, expect, it } from 'vitest';
import { apiProblemSchema, apiSuccessSchema } from './api.js';

describe('API envelopes', () => {
  it('accepts a success payload', () => {
    expect(apiSuccessSchema.parse({ data: { ready: true } })).toEqual({
      data: { ready: true },
    });
  });

  it('rejects an error without a request id', () => {
    expect(() => apiProblemSchema.parse({
      error: { code: 'bad_request', message: '请求无效' },
    })).toThrow();
  });
});
