/**
 * Guard: the Dev Tools endpoints exist only where NODE_ENV is development or test (DT-1). They
 * show decrypted workflow inputs and activity outputs, so staging, pre-prod and an unset
 * NODE_ENV get the production answer: 404, as if the routes did not exist.
 */
import { Injectable, CanActivate, ExecutionContext, NotFoundException } from '@nestjs/common';
import { isDevOrTest } from '@infrastructure/config/runtime-env';

@Injectable()
export class DevToolsGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (!isDevOrTest()) {
      throw new NotFoundException();
    }
    return true;
  }
}
