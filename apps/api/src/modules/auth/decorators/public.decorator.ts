import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route as unauthenticated (the /public/* customer channel, invitation
 * acceptance, login endpoints themselves). The global JwtAuthGuard skips these.
 * Everything else in the system requires a valid acting-employee JWT (NFR8 —
 * enforcement at the system level, not hidden in the UI).
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
