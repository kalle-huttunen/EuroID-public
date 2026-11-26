import { BadRequestException } from '@nestjs/common';

export const MAX_OFFSET = 10000;
export const MAX_PAGE_SIZE = 500;

/**
 * Validates pagination bounds for start/end style (Refine convention: _start, _end).
 * Throws BadRequestException if out of bounds.
 */
export function validatePaginationBounds(
  start?: number,
  end?: number,
): { start?: number; end?: number } {
  if (start != null && (start < 0 || start > MAX_OFFSET)) {
    throw new BadRequestException(`start must be 0-${MAX_OFFSET}`);
  }
  if (end != null && start != null && end - start > MAX_PAGE_SIZE) {
    throw new BadRequestException(`Page size must be <= ${MAX_PAGE_SIZE}`);
  }
  if (start != null && end != null && end <= start) {
    throw new BadRequestException('end must be greater than start');
  }
  return { start, end };
}

/**
 * Validates page/limit style pagination.
 * Throws BadRequestException if out of bounds.
 */
export function validatePageLimit(page: number, limit: number): { page: number; limit: number } {
  if (page < 1 || limit < 1) {
    throw new BadRequestException('page and limit must be >= 1');
  }
  if (limit > MAX_PAGE_SIZE) {
    throw new BadRequestException(`limit must be <= ${MAX_PAGE_SIZE}`);
  }
  const offset = (page - 1) * limit;
  if (offset > MAX_OFFSET) {
    throw new BadRequestException(`Offset (page * limit) must be <= ${MAX_OFFSET}`);
  }
  return { page, limit };
}
