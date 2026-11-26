import { ConflictException } from '@nestjs/common';

/** One refused field: the HR source that masters it, or none when an override holds it. */
export interface RefusedField {
  field: string;
  owner?: string;
}

/**
 * An update that changes a field an HR source masters, or a department or job title with an
 * active override, refused (IdentityMutationService, owner decision 2026-11-24): 409 for
 * PATCH /identity/:id. SCIM inbound answers it in SCIM's error model instead (400, scimType
 * "mutability"). The message names each field and its owner.
 */
export class HrMasteredFieldsException extends ConflictException {
  constructor(
    public readonly refused: RefusedField[],
    message: string,
  ) {
    super(message);
  }
}
