import assert from "node:assert/strict";

import {
  createMessageRequestSchema,
  createMessageResponseSchema,
  serverEventSchema,
} from "./generated/Wire.zod";

assert.deepEqual(createMessageRequestSchema.parse({ body: "hello" }), {
  body: "hello",
});
assert.throws(() => createMessageRequestSchema.parse({ body: 42 }));

const message = { id: "9007199254740993", body: "hello", createdAtMs: "1" };
assert.deepEqual(createMessageResponseSchema.parse({ message }), { message });
assert.deepEqual(
  serverEventSchema.parse({ type: "message_created", message }),
  { type: "message_created", message },
);
assert.throws(() =>
  serverEventSchema.parse({ type: "message_created", message: { ...message, id: 1 } }),
);
assert.throws(() => serverEventSchema.parse({ type: "unknown", message }));
