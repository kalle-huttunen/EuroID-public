import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';
import { CampaignStatus } from '../schemas/review-campaign.schema';

export const ListCampaignsQuerySchema = z.object({
  status: z.nativeEnum(CampaignStatus).optional(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
});

export class ListCampaignsQueryDto extends createZodDto(ListCampaignsQuerySchema) {}
