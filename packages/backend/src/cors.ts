import { cors } from 'hono/cors';

export const SILVERHAND_CORS_ALLOW_HEADERS = [
  'Authorization',
  'Content-Type',
  'X-Silverhand-User-Id',
] as const;

export function silverhandCors() {
  return cors({
    origin: '*',
    allowHeaders: [...SILVERHAND_CORS_ALLOW_HEADERS],
  });
}
