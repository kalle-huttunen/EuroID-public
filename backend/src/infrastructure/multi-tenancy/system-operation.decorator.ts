import { SetMetadata } from '@nestjs/common';

export const IS_SYSTEM_OPERATION = 'isSystemOperation';

/** Marks an endpoint as a system operation (bypasses TenantGuard). */
export const SystemOperation = () => SetMetadata(IS_SYSTEM_OPERATION, true);
