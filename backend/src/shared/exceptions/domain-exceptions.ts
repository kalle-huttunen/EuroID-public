import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Base domain exception for identity-related errors.
 */
export class IdentityException extends HttpException {
  constructor(message: string, statusCode = HttpStatus.UNPROCESSABLE_ENTITY) {
    super({ error: 'IdentityError', message }, statusCode);
  }
}

/**
 * Exception for provisioning failures (connector execution, target system errors).
 */
export class ProvisioningException extends HttpException {
  constructor(message: string, statusCode = HttpStatus.BAD_GATEWAY) {
    super({ error: 'ProvisioningError', message }, statusCode);
  }
}

/**
 * Exception for connector configuration or API errors.
 */
export class ConnectorException extends HttpException {
  constructor(message: string, statusCode = HttpStatus.BAD_REQUEST) {
    super({ error: 'ConnectorError', message }, statusCode);
  }
}
