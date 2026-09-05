// Representative single-file output assembled from the current ts-rs bindings.
export type CreateMessageRequest = { body: string };

export type MessageDto = {
  id: string;
  body: string;
  createdAtMs: string;
};

export type CreateMessageResponse = { message: MessageDto };

export type ServerEvent = {
  type: "message_created";
  message: MessageDto;
};
