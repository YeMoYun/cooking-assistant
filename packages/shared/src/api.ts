import { z } from 'zod';

export const apiSuccessSchema = z.object({ data: z.unknown() }).strict();

export const apiProblemSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.unknown().optional(),
  }).strict(),
}).strict();

export type ApiSuccess<T> = { data: T };
export type ApiProblem = z.infer<typeof apiProblemSchema>;

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
