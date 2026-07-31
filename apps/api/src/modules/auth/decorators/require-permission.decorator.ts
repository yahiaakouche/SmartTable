import { SetMetadata } from '@nestjs/common';
import { PermissionKey } from '@smarttable/shared-types';

/**
 * Declares which permission a route requires. The global PermissionsGuard
 * evaluates it against the hard-coded PRD §11 baseline first, then the
 * DB-configurable role_permissions layer (Security Architecture §2).
 */
export const REQUIRED_PERMISSION_KEY = 'requiredPermission';
export const RequirePermission = (key: PermissionKey) => SetMetadata(REQUIRED_PERMISSION_KEY, key);
