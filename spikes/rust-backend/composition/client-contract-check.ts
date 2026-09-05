import type { CreateMessageRequest } from '../bindings/CreateMessageRequest.js';
import type { CreateMessageResponse } from '../bindings/CreateMessageResponse.js';
import type { ServerEvent } from '../bindings/ServerEvent.js';

// This file is compile-only. It proves the client profile consumes the
// pre-generated Rust wire artifact; runtime validation remains a separate gate.
export function requestBody(body: string): CreateMessageRequest {
  return { body };
}

export function createdMessageId(response: CreateMessageResponse): string {
  return response.message.id;
}

export function eventMessageId(event: ServerEvent): string {
  switch (event.type) {
    case 'message_created':
      return event.message.id;
  }
}
