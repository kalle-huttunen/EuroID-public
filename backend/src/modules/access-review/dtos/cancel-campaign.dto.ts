import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

/**
 * Body of POST /access-reviews/campaigns/:id/cancel. Optional: a request without a body cancels
 * without a reason. The reason goes to the audit log (access_review.campaign_cancelled).
 */
export const CancelCampaignBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

/** For Swagger; the controller parses the body itself, which may be absent. */
export class CancelCampaignBodyDto extends createZodDto(CancelCampaignBodySchema) {}
