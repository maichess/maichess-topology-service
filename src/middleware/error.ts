import { Request, Response, NextFunction } from 'express';

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error(err);

  const statusCode = (err as { statusCode?: number }).statusCode;
  const message = (err instanceof Error) ? err.message : 'Internal server error';

  if (statusCode && statusCode >= 400 && statusCode < 600) {
    res.status(statusCode).json({ error: message });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
}
