import { cors } from 'hono/cors';
import {
  X_SILVERHAND_LEGACY_USER_ID_HEADER,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';

export const SILVERHAND_CORS_ALLOW_HEADERS = [
  'Authorization',
  'Content-Type',
  X_SILVERHAND_LEGACY_USER_ID_HEADER,
  X_SILVERHAND_PRINCIPAL_HEADER,
] as const;

export function silverhandCors() {
  return cors({
    origin: '*',
    allowHeaders: [...SILVERHAND_CORS_ALLOW_HEADERS],
  });
}
