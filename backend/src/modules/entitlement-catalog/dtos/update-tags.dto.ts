import { z } from 'zod';

export const GovernanceTagEnum = z.enum([
  'PROTECTED',
  'MANDATORY',
  'FLAGGED',
  'REVIEW_REQUIRED',
]);

export const UpdateGovernanceTagsSchema = z.object({
  governanceTags: z.array(GovernanceTagEnum).max(20),
});

export type UpdateGovernanceTagsDto = z.infer<typeof UpdateGovernanceTagsSchema>;
