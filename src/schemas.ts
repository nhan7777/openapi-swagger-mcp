import { z } from 'zod';
import type { RequestInput } from './types.js';

const json = z.json();
const uploadPart = z.object({ field: z.string().min(1), path: z.string().min(1), filename: z.string().optional(), contentType: z.string().optional() }).strict();

export const BodySchema = z.union([
  z.object({ json: z.object({ value: json, contentType: z.string().optional() }).strict() }).strict(),
  z.object({ form: z.object({ fields: z.record(z.string(), json), contentType: z.string().optional() }).strict() }).strict(),
  z
    .object({
      multipart: z
        .object({ fields: z.record(z.string(), json).optional(), files: z.array(uploadPart).optional(), contentType: z.string().optional() })
        .strict(),
    })
    .strict(),
  z.object({ binary: z.object({ file: z.string().min(1), contentType: z.string().min(1) }).strict() }).strict(),
]);

/** Envelope is strict; the JSON carried inside (path/query/body values) is intentionally permissive. */
export const RequestInputSchema = z
  .object({
    path: z.record(z.string(), json).optional(),
    query: z.record(z.string(), json).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    cookies: z.record(z.string(), z.string()).optional(),
    body: BodySchema.optional(),
  })
  .strict();

export function parseRequestInput(v: unknown): RequestInput {
  return RequestInputSchema.parse(v) as RequestInput;
}

export const ComponentValueSchema = z.union([z.string().min(1), z.object({ username: z.string(), password: z.string() }).strict()]);

export const ImportedComponentSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1), type: z.literal('bearer'), value: ComponentValueSchema }).strict(),
  z.object({ id: z.string().min(1), type: z.literal('basic'), value: ComponentValueSchema }).strict(),
  z.object({ id: z.string().min(1), type: z.literal('apiKey'), in: z.enum(['header', 'query', 'cookie']), name: z.string().min(1), value: ComponentValueSchema }).strict(),
]);
export type ImportedComponent = z.infer<typeof ImportedComponentSchema>;

export const SourceComponentSchema = z.discriminatedUnion('type', [
  z.object({ sourceId: z.string().min(1), id: z.string().min(1).optional(), type: z.literal('bearer') }).strict(),
  z.object({ sourceId: z.string().min(1), id: z.string().min(1).optional(), type: z.literal('basic') }).strict(),
  z.object({ sourceId: z.string().min(1), id: z.string().min(1).optional(), type: z.literal('apiKey'), in: z.enum(['header', 'query', 'cookie']), name: z.string().min(1) }).strict(),
]);
export type SourceComponent = z.infer<typeof SourceComponentSchema>;

export const CookieImportSchema = z.object({ name: z.string().min(1), value: z.string() }).strict();

export const AuthSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('default') }).strict(),
  z.object({ mode: z.literal('profile'), profileId: z.string().min(1) }).strict(),
  z.object({ mode: z.literal('session'), sessionId: z.string().min(1) }).strict(),
  z.object({ mode: z.literal('anonymous') }).strict(),
]);
export type AuthSelector = z.infer<typeof AuthSchema>;

export const CaptureSchema = z
  .object({
    /** Existing session id for this service to update; omitted = create a new session. */
    sessionId: z.string().min(1).optional(),
    successStatuses: z.array(z.number().int().min(100).max(599)).optional(),
    tokens: z
      .array(
        z.discriminatedUnion('from', [
          z.object({ id: z.string().min(1), type: z.enum(['bearer', 'basic', 'apiKey']), in: z.enum(['header', 'query', 'cookie']).optional(), name: z.string().min(1).optional(), from: z.literal('body'), pointer: z.string() }).strict(),
          z.object({ id: z.string().min(1), type: z.enum(['bearer', 'basic', 'apiKey']), in: z.enum(['header', 'query', 'cookie']).optional(), name: z.string().min(1).optional(), from: z.literal('header'), header: z.string().min(1) }).strict(),
        ]),
      )
      .default([]),
    cookies: z.boolean().default(false),
  })
  .strict();
export type CaptureSpec = z.infer<typeof CaptureSchema>;
