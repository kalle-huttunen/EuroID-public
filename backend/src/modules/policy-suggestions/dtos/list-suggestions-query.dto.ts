import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';
import { SuggestionType } from '../schemas/suggestion.schema';

export const ListSuggestionsQuerySchema = z.object({
  type: z.nativeEnum(SuggestionType).optional(),
  status: z.string().optional(),
  confidenceMin: z.coerce.number().optional(),
  page: z.coerce.number().int().min(0).max(10000).optional(),
  limit: z.coerce.number().optional(),
});

export class ListSuggestionsQueryDto extends createZodDto(ListSuggestionsQuerySchema) {}
