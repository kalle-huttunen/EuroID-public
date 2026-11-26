import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';
import { setsAttributeControl } from '../attribute-controls';

const attributeControl = (attribute: string) =>
  z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe(
      `Override of the HR-mastered ${attribute}: reconcile and the policy contracts take it until ` +
        'it is removed or expires. "" or null removes it.',
    );

/**
 * PATCH /identity/v2/:id/controls body. Fields left out keep their value. Setting an attribute
 * control (manualDepartment, manualJobTitle) needs a reason and may carry an expiry
 * (attribute-controls.ts); removing one needs neither.
 */
export const UpdateIdentityControlsObjectSchema = z
  .object({
    isLoginDisabled: z.boolean().optional(),
    manualDepartment: attributeControl('departmentName'),
    manualJobTitle: attributeControl('jobTitle'),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe('Why: required to set an attribute control, optional to remove one; audited.'),
    expiresAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('When the attribute controls set by this request end (ISO date-time, future).'),
    overrides: z
      .object({
        email: z
          .string()
          .trim()
          .toLowerCase()
          .max(320)
          .refine((value) => value === '' || z.string().email().safeParse(value).success, {
            message: 'Must be an email, or "" or null to remove the override',
          })
          .nullable()
          .optional()
          .describe(
            'Replaces the profile email at every reconcile (stored lower-cased). "" or null ' +
              'removes it. An email another live identity has is refused (409). Audited.',
          ),
      })
      .optional(),
  })
  .strict();

/** The body with its cross-field rules: reason to set, expiry only with a set and in the future. */
export const UpdateIdentityControlsSchema = UpdateIdentityControlsObjectSchema.superRefine(
  (body, ctx) => {
    const sets = setsAttributeControl(body);
    if (sets && !body.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A reason is required to set manualDepartment or manualJobTitle',
      });
    }
    if (body.expiresAt && !sets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'expiresAt applies to a manualDepartment or manualJobTitle this request sets',
      });
    }
    if (body.expiresAt && new Date(body.expiresAt).getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'expiresAt must be in the future',
      });
    }
  },
);

export type UpdateIdentityControls = z.infer<typeof UpdateIdentityControlsSchema>;

/** The body's shape for the OpenAPI spec; the controller parses UpdateIdentityControlsSchema. */
export class UpdateIdentityControlsDto extends createZodDto(UpdateIdentityControlsObjectSchema) {}
