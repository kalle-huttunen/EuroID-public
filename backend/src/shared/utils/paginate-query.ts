import type { Model } from 'mongoose';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginateOptions {
  skip: number;
  limit: number;
  sort?: Record<string, 1 | -1>;
}

/**
 * Generic pagination utility for Mongoose models.
 * Runs find + countDocuments in parallel for efficiency.
 */
export async function paginateQuery<T>(
  model: Model<T>,
  filter: Record<string, unknown>,
  options: PaginateOptions,
): Promise<PaginatedResult<T>> {
  const { skip, limit, sort } = options;
  const safeLimit = limit <= 0 ? 1 : limit;
  const [items, total] = await Promise.all([
    model
      .find(filter)
      .skip(skip)
      .limit(safeLimit)
      .sort(sort ?? {})
      .lean()
      .exec(),
    model.countDocuments(filter).exec(),
  ]);
  const page = safeLimit > 0 ? Math.floor(skip / safeLimit) + 1 : 1;
  const totalPages = safeLimit > 0 ? Math.ceil(total / safeLimit) || 1 : 1;
  return {
    items: items as T[],
    total,
    page,
    limit: safeLimit,
    totalPages,
  };
}
