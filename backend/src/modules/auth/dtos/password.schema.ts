import { z } from 'zod';

export const STRONG_PASSWORD_SCHEMA = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{12,}$/,
    'Password must contain uppercase, lowercase, number, and special character',
  );
