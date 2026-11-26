/**
 * UPN resolution errors
 */

export class UpnExhaustedError extends Error {
  constructor(
    message: string,
    public readonly candidatesChecked: string[],
    public readonly suggestedUpn?: string,
  ) {
    super(message);
    this.name = 'UpnExhaustedError';
    Object.setPrototypeOf(this, UpnExhaustedError.prototype);
  }
}

export class InvalidDomainError extends Error {
  constructor(
    message: string,
    public readonly domain: string,
    public readonly verifiedDomains: string[],
  ) {
    super(message);
    this.name = 'InvalidDomainError';
    Object.setPrototypeOf(this, InvalidDomainError.prototype);
  }
}
