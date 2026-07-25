import { z } from 'zod'

export const mediaSchema = z.object({
  id: z.string(),
  /** Object key inside the R2 bucket. */
  key: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  alt: z.string().nullable(),
  url: z.string(),
  createdAt: z.string(),
})

export type Media = z.infer<typeof mediaSchema>

export const updateMediaSchema = z.object({
  alt: z.string().max(500).nullable().optional(),
  filename: z.string().min(1).max(255).optional(),
})

export type UpdateMediaInput = z.infer<typeof updateMediaSchema>

/** Upper bound for a single upload. Workers cap request bodies at 100 MB on paid plans. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export const ALLOWED_UPLOAD_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'application/pdf',
  'video/mp4',
  'text/plain',
  'text/csv',
  'application/json',
] as const

export function isAllowedUploadType(contentType: string): boolean {
  return (ALLOWED_UPLOAD_TYPES as readonly string[]).includes(contentType.split(';')[0]!.trim())
}
