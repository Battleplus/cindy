import { describe, expect, it } from 'vitest';

import {
  isUnsupportedResponsesImageErrorPayload,
  UnsupportedResponsesFeatureError,
} from '../types.js';

function unsupportedFeaturePayload(feature: string, code = 'unsupported_feature'): string {
  return JSON.stringify({
    error: {
      type: 'invalid_request_error',
      code,
      message: new UnsupportedResponsesFeatureError(feature).message,
    },
  });
}

function codexUnexpectedResponse(messageOrBody: string): string {
  return `unexpected status 400 Bad Request: ${messageOrBody}, url: http://127.0.0.1/v1/responses`;
}

describe('isUnsupportedResponsesImageErrorPayload', () => {
  it.each([
    "input content part 'input_image'",
    "input content part 'image_url'",
    "input content part 'image'",
    'input_image',
    'input_image.file_id',
  ])('accepts current and compatible image feature shapes: %s', (feature) => {
    expect(isUnsupportedResponsesImageErrorPayload(unsupportedFeaturePayload(feature))).toBe(true);
  });

  it('accepts the bridge message rendered by the pinned Codex runtime', () => {
    const message =
      "Responses feature is not supported by the Chat Completions bridge: input content part 'input_image'";

    expect(isUnsupportedResponsesImageErrorPayload(codexUnexpectedResponse(message))).toBe(true);
  });

  it('accepts a Codex error that retains the serialized bridge response body', () => {
    const payload = unsupportedFeaturePayload("input content part 'input_image'");

    expect(isUnsupportedResponsesImageErrorPayload(codexUnexpectedResponse(payload))).toBe(true);
  });

  it('accepts upstream provider image rejection (DeepSeek-style 400)', () => {
    const payload = JSON.stringify({
      error: {
        code: 'invalid_request_error',
        message: 'image_url content part is not supported by this model',
      },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it('accepts upstream provider multimodal rejection', () => {
    const payload = JSON.stringify({
      error: {
        code: 'invalid_request',
        message: 'This model does not support multimodal input',
      },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it('accepts handler-wrapped upstream image rejection (DeepSeek via bridge)', () => {
    // handler.ts wraps: responsesError(status, 'upstream_error', rawUpstreamBody)
    const innerError = JSON.stringify({
      error: { code: 'invalid_request_error', message: 'image_url content part is not supported' },
    });
    const payload = JSON.stringify({
      error: { code: 'upstream_error', message: innerError },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it('accepts upstream rejection using error.type without a code field', () => {
    const payload = JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'This model does not support image_url content parts',
      },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it('accepts a plain-text (non-JSON) upstream 400 body wrapped by the handler', () => {
    const payload = JSON.stringify({
      error: {
        code: 'upstream_error',
        message: 'image_url content part is not supported by this model',
      },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it('accepts a handler-wrapped rejection whose inner error uses error.type', () => {
    const innerError = JSON.stringify({
      error: { type: 'invalid_request_error', message: 'image input is not supported' },
    });
    const payload = JSON.stringify({
      error: { code: 'upstream_error', message: innerError },
    });
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(true);
  });

  it.each([
    JSON.stringify({
      error: { code: 'invalid_request_error', message: 'Invalid image_url: image exceeds maximum size' },
    }),
    JSON.stringify({
      error: { code: 'invalid_request_error', message: 'image_url must be a valid URL' },
    }),
    JSON.stringify({
      error: { code: 'invalid_request_error', message: 'image exceeds maximum size' },
    }),
    JSON.stringify({
      error: { code: 'upstream_error', message: 'Invalid image_url: image exceeds maximum size' },
    }),
  ])('rejects invalid-image-content errors (not capability rejection): %s', (payload) => {
    // A message about the image being invalid (size, format, URL) is NOT a
    // capability rejection — stripping the attachment would resend text without
    // the image the user asked about.
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(false);
  });

  it.each([
    unsupportedFeaturePayload("input content part 'input_file'"),
    unsupportedFeaturePayload("input content part 'input_image'", 'invalid_request'),
    JSON.stringify({ error: { code: 'unsupported_feature', message: 'input_image' } }),
    codexUnexpectedResponse(
      "Responses feature is not supported by the Chat Completions bridge: input content part 'input_file'",
    ),
    'unexpected status 401 Unauthorized: Responses feature is not supported by the Chat Completions bridge: input_image',
    'not json',
    '',
  ])('rejects unrelated or malformed payloads: %s', (payload) => {
    expect(isUnsupportedResponsesImageErrorPayload(payload)).toBe(false);
  });
});
