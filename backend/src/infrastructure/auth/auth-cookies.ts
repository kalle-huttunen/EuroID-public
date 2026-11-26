/**
 * httpOnly cookie helpers for FA-1 token storage migration.
 * Tokens stored in cookies are not accessible to JavaScript (XSS mitigation).
 */

import { Response } from 'express';
import { isDevOrTest } from '../config/runtime-env';

const ACCESS_TOKEN_MAX_AGE = 15 * 60; // 15 minutes
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

/** HTTPS only, except in development and test (http://localhost); read at each call. */
const isSecure = (): boolean => !isDevOrTest();

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: isSecure(),
    sameSite: 'strict',
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE * 1000,
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: isSecure(),
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: REFRESH_TOKEN_MAX_AGE * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie('access_token', {
    path: '/',
    httpOnly: true,
    secure: isSecure(),
    sameSite: 'strict',
  });
  res.clearCookie('refresh_token', {
    path: '/api/v1/auth',
    httpOnly: true,
    secure: isSecure(),
    sameSite: 'strict',
  });
}
