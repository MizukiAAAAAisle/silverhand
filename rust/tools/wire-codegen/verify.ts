import assert from 'node:assert/strict';

import type {
  CreateFoundationMessageRequest,
  CreateFoundationMessageResponse,
  FoundationMessagePageResponse,
  HealthResponse,
  ServerEvent,
} from '../../../packages/shared/src/generated/rust-backend/wire';
import {
  apiErrorResponseSchema,
  createFoundationMessageRequestSchema,
  createFoundationMessageResponseSchema,
  foundationMessagePageResponseSchema,
  healthResponseSchema,
  serverEventSchema,
} from '../../../packages/shared/src/generated/rust-backend/wire.zod';

const health: HealthResponse = { status: 'ok', wireContractVersion: 1 };
assert.deepEqual(healthResponseSchema.parse(health), health);
assert.throws(() => healthResponseSchema.parse({ ...health, status: 'unknown' }));
assert.throws(() => healthResponseSchema.parse({ ...health, extra: true }));
for (const version of [2, -1, 1.5]) {
  assert.throws(() => healthResponseSchema.parse({ ...health, wireContractVersion: version }));
}

const request: CreateFoundationMessageRequest = { body: 'hello' };
assert.deepEqual(createFoundationMessageRequestSchema.parse(request), request);
assert.throws(() => createFoundationMessageRequestSchema.parse({}));
assert.throws(() => createFoundationMessageRequestSchema.parse({ ...request, extra: true }));

const message = { id: '1', body: 'hello', createdAtMs: '1000' };
const created: CreateFoundationMessageResponse = {
  wireContractVersion: 1,
  message,
};
assert.deepEqual(createFoundationMessageResponseSchema.parse(created), created);
assert.throws(() =>
  createFoundationMessageResponseSchema.parse({
    ...created,
    message: { ...message, id: 1 },
  }),
);
assert.throws(() =>
  createFoundationMessageResponseSchema.parse({
    ...created,
    message: { ...message, createdAtMs: 1000 },
  }),
);

const emptyPage: FoundationMessagePageResponse = {
  wireContractVersion: 1,
  total: '0',
  latest: null,
};
assert.deepEqual(foundationMessagePageResponseSchema.parse(emptyPage), emptyPage);
assert.throws(() =>
  foundationMessagePageResponseSchema.parse({
    wireContractVersion: 1,
    total: '0',
  }),
);

const event: ServerEvent = {
  type: 'message_created',
  wireContractVersion: 1,
  message,
};
assert.deepEqual(serverEventSchema.parse(event), event);
assert.throws(() => serverEventSchema.parse({ ...event, type: 'unknown' }));

const safeError = {
  wireContractVersion: 1,
  error: { code: 'internal', message: 'internal server error' },
};
assert.deepEqual(apiErrorResponseSchema.parse(safeError), safeError);
assert.throws(() =>
  apiErrorResponseSchema.parse({
    ...safeError,
    error: { ...safeError.error, code: 'driver_error' },
  }),
);
