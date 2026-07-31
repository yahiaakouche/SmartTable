import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { EmployeeRole } from '@smarttable/shared-types';

/** The authenticated acting-employee context the JwtAuthGuard attaches. */
export interface ActingEmployee {
  id: string;
  name: string;
  role: EmployeeRole;
}

/**
 * Controller-layer access to the acting employee — the ONLY way controllers
 * learn who is calling (audit trails, "collected_by", etc. all need this).
 */
export const CurrentEmployee = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ActingEmployee => {
    const request = ctx.switchToHttp().getRequest<{ employee: ActingEmployee }>();
    return request.employee;
  },
);
