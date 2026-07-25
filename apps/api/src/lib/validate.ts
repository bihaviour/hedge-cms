import type { Context } from 'hono'
import type { z } from 'zod'
import type { AppEnv } from '../env'
import { ApiError } from './errors'

/** Parses and validates a JSON body, converting zod failures into a 400 with field details. */
export async function validate<T extends z.ZodType>(
  c: Context<AppEnv>,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw ApiError.badRequest('Request body must be valid JSON')
  }

  const result = schema.safeParse(body)
  if (!result.success) throw ApiError.fromZod(result.error)
  return result.data
}

/** Same as `validate`, but reads from the query string. */
export function validateQuery<T extends z.ZodType>(c: Context<AppEnv>, schema: T): z.infer<T> {
  const result = schema.safeParse(c.req.query())
  if (!result.success) throw ApiError.fromZod(result.error)
  return result.data
}
