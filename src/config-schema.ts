import { z } from 'zod';

// Public configuration schema. Structural rules (source exclusivity, auth alternatives, recipe shapes) are encoded
// as unions so the emitted JSON Schema rejects the same documents as the loader. Cross-references (does this
// profile exist, is this credential defined) are checked by `loadConfig`.

const MiB = 1024 * 1024;
const posInt = (def: number, max: number) => z.number().int().positive().max(max).default(def);
const json = z.json();
const nonEmpty = z.string().min(1);

export const LimitsSchema = z
  .object({
    requestTimeoutMs: posInt(30000, 600000),
    maxConcurrentRequests: posInt(8, 256),
    recipeConcurrency: posInt(2, 64),
    specDocumentBytes: posInt(10 * MiB, 512 * MiB),
    refGraphDocuments: posInt(100, 10000),
    refGraphBytes: posInt(50 * MiB, 2048 * MiB),
    refGraphDepth: posInt(64, 1000),
    responseBytes: posInt(50 * MiB, 4096 * MiB),
    uploadBytes: posInt(50 * MiB, 4096 * MiB),
    sessionArtifactBytes: posInt(250 * MiB, 16384 * MiB),
    inlineStringBytes: posInt(4096, 1 * MiB),
    toolOutputBytes: posInt(32768, 4 * MiB),
    artifactPageBytes: posInt(16384, 1 * MiB),
    maxRedirects: posInt(5, 20),
  })
  .strict()
  .prefault({});

// ---- secrets -------------------------------------------------------------------------------

/** RFC 6901 JSON Pointer. The empty string is the document root; URI-fragment forms such as `#/a` are not accepted. */
export const JsonPointerSchema = z
  .string()
  .regex(/^(?:\/(?:[^~]|~[01])*)?$/, 'must be a JSON Pointer: empty, or starting with "/" with "~" only as ~0 or ~1');

export const EnvRef = z.object({ fromEnv: nonEmpty }).strict();
export const FileRef = z.object({ fromFile: nonEmpty, pointer: JsonPointerSchema.optional() }).strict();
export const CredentialRef = z.object({ fromCredential: nonEmpty }).strict();

/** A literal, an environment variable, or a JSON file (optionally a pointer into it). */
export const StaticSecret = z.union([nonEmpty, EnvRef, FileRef]);
export type StaticSecret = z.infer<typeof StaticSecret>;
/** A static secret or a named credential held by the owner (captured or initial). */
export const Secret = z.union([nonEmpty, EnvRef, FileRef, CredentialRef]);
export type Secret = z.infer<typeof Secret>;
const EmptyOkStatic = z.union([z.string(), EnvRef, FileRef]);
const EmptyOkSecret = z.union([z.string(), EnvRef, FileRef, CredentialRef]);

// ---- auth methods --------------------------------------------------------------------------

function authMethods<S extends z.ZodType, B extends z.ZodType, C extends z.ZodRawShape>(secret: S, basicSecret: B, cookies: C) {
  const apiKeyOne = z.union([
    z.object({ header: nonEmpty, value: secret }).strict(),
    z.object({ query: nonEmpty, value: secret }).strict(),
    z.object({ cookie: nonEmpty, value: secret }).strict(),
  ]);
  const apiKey = z.union([apiKeyOne, z.array(apiKeyOne).min(1)]);
  const bearer = z.object({ token: secret }).strict();
  const basic = z.object({ username: basicSecret, password: basicSecret }).strict();
  return z.union([
    z.object({ bearer, apiKey: apiKey.optional(), ...cookies }).strict(),
    z.object({ basic, apiKey: apiKey.optional(), ...cookies }).strict(),
    z.object({ apiKey, ...cookies }).strict(),
  ]);
}
const optionalCookies = { cookies: z.literal(true).optional() };
const CookiesOnly = z.object({ cookies: z.literal(true) }).strict();

/** Auth for owners (services, profiles) and recipe requests: may reference named credentials and the cookie jar. */
export const AuthMethods = z.union([authMethods(Secret, EmptyOkSecret, optionalCookies), CookiesOnly]);
export type AuthMethods = z.infer<typeof AuthMethods>;
/** Auth for specification fetches: static only, no cookie jar, no credential references. */
const SpecAuthMethods = authMethods(StaticSecret, EmptyOkStatic, {});

// ---- recipes -------------------------------------------------------------------------------

type JsonValue = z.infer<typeof json>;

/**
 * Request template. A reserved key (`fromEnv`, `fromFile`, `fromCredential`, `literal`) is only legal as exactly one of
 * the reference shapes; every other object is ordinary data. `{ literal }` is raw JSON that is never substituted.
 */
export type Template =
  | string
  | number
  | boolean
  | null
  | Template[]
  | { [key: string]: Template }
  | z.infer<typeof EnvRef>
  | z.infer<typeof FileRef>
  | z.infer<typeof CredentialRef>
  | { literal: JsonValue };

const OrdinaryKey = z.string().regex(/^(?!(?:fromEnv|fromFile|fromCredential|literal)$)/);

// The explicit annotation is required: a recursive schema cannot infer its own type.
export const TemplateSchema: z.ZodType<Template> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(TemplateSchema),
    EnvRef,
    FileRef,
    CredentialRef,
    z.object({ literal: json }).strict(),
    z.record(OrdinaryKey, TemplateSchema),
  ]),
);
const TemplateRecord = z.record(z.string(), TemplateSchema);
const UploadPart = z
  .object({ field: nonEmpty, path: nonEmpty, filename: z.string().optional(), contentType: z.string().optional() })
  .strict();

const RecipeBody = z.union([
  z.object({ json: TemplateSchema, contentType: z.string().optional() }).strict(),
  z.object({ form: TemplateRecord, contentType: z.string().optional() }).strict(),
  z
    .object({
      multipart: z
        .object({ fields: TemplateRecord.optional(), files: z.array(UploadPart).optional(), contentType: z.string().optional() })
        .strict(),
    })
    .strict(),
  z.object({ binary: z.object({ file: nonEmpty, contentType: nonEmpty }).strict() }).strict(),
]);

const CaptureSource = z.union([z.object({ bodyPointer: JsonPointerSchema }).strict(), z.object({ header: nonEmpty }).strict()]);

/** Nonempty map: `minProperties` is emitted into JSON Schema via meta; the refine enforces it in Zod. */
const CaptureCredentials = z
  .record(nonEmpty, CaptureSource)
  .refine((o) => Object.keys(o).length > 0, 'capture at least one credential')
  .meta({ minProperties: 1 });

/** Unique, nonempty HTTP statuses: `uniqueItems` is emitted into JSON Schema via meta; the refine enforces it in Zod. */
const SuccessStatuses = z
  .array(z.number().int().min(100).max(599))
  .min(1)
  .refine((a) => new Set(a).size === a.length, 'duplicate status')
  .meta({ uniqueItems: true });

export const Recipe = z
  .object({
    request: z
      .object({
        service: nonEmpty.optional(),
        operation: nonEmpty,
        path: TemplateRecord.optional(),
        query: TemplateRecord.optional(),
        headers: TemplateRecord.optional(),
        cookies: TemplateRecord.optional(),
        body: RecipeBody.optional(),
        auth: AuthMethods.optional(),
      })
      .strict(),
    successStatuses: SuccessStatuses.optional(),
    // At least one credential or cookies: expressed as variants so JSON Schema rejects `{}` and `{credentials: {}}` too.
    capture: z.union([
      z.object({ credentials: CaptureCredentials, cookies: z.literal(true).optional() }).strict(),
      z.object({ cookies: z.literal(true) }).strict(),
    ]),
  })
  .strict();
export type Recipe = z.infer<typeof Recipe>;

// ---- owners: profiles and services ---------------------------------------------------------

export const OwnerExtras = z.object({
  credentials: z.record(nonEmpty, StaticSecret).optional(),
  authentication: Recipe.optional(),
  refresh: Recipe.optional(),
});
export type OwnerExtras = z.infer<typeof OwnerExtras>;

const NamedProfile = z.object({ auth: AuthMethods, ...OwnerExtras.shape }).strict();

const SpecObject = z
  .object({
    source: z.union([z.object({ url: nonEmpty }).strict(), z.object({ file: nonEmpty }).strict()]),
    auth: SpecAuthMethods.optional(),
    allowedOrigins: z.array(z.string()).default([]),
    roots: z.array(z.string()).default([]),
  })
  .strict();

const ServiceBase = {
  baseUrl: nonEmpty,
  /** A URL or a file path, or the object form for refs/roots/spec-fetch auth. */
  spec: z.union([nonEmpty, SpecObject]),
  tls: z.object({ caFile: z.string().optional(), verify: z.boolean().optional() }).strict().optional(),
};

/** A service that carries its own auth, recipes and initial credentials. */
const InlineService = z.object({ ...ServiceBase, auth: AuthMethods, ...OwnerExtras.shape }).strict();
export type InlineService = z.infer<typeof InlineService>;

const Service = z.union([
  z.object({ ...ServiceBase }).strict(),
  InlineService,
  z.object({ ...ServiceBase, auth: z.object({ profile: nonEmpty }).strict() }).strict(),
  z
    .object({
      ...ServiceBase,
      auth: z.object({ profiles: z.array(nonEmpty).min(1), defaultProfile: nonEmpty.optional() }).strict(),
    })
    .strict(),
]);

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).default(1),
    services: z.record(nonEmpty, Service),
    profiles: z.record(nonEmpty, NamedProfile).default({}),
    /** Advanced: shared source catalog that session imports may reference by id. Not needed for service auth. */
    credentialSources: z.record(nonEmpty, z.union([EnvRef, FileRef])).default({}),
    files: z
      .object({
        uploadRoots: z.array(z.string()).default([]),
        exportRoots: z.array(z.string()).default([]),
        artifactRoot: z.string().optional(),
      })
      .strict()
      .prefault({}),
    /** Response fields known to carry encoded content. `pointer` may use `*` for one path segment. */
    encodedFields: z
      .array(
        z
          .object({
            service: z.string().optional(),
            operation: z.string().optional(),
            pointer: nonEmpty,
            encoding: z.literal('base64').default('base64'),
            mediaType: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    limits: LimitsSchema,
  })
  .strict();

export type Limits = z.infer<typeof LimitsSchema>;
