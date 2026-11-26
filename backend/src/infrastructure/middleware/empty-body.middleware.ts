import type { NextFunction, Request, Response } from 'express';

/**
 * Gives a request without a body an empty object as its body.
 *
 * Express 5 leaves `req.body` undefined when no body was sent (Express 4 set `{}`). `@Body()` then
 * hands the validation pipe `undefined`, and a route whose body fields are all optional answered
 * 400 ": Required" to a POST without a body. Registered before the body parsers: a parser that
 * reads a body replaces the empty object, and one that finds none leaves it.
 */
export function emptyBodyAsObject(req: Request, _res: Response, next: NextFunction): void {
  if (req.body === undefined) req.body = {};
  next();
}
