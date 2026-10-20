export type Dialect = 'swagger2' | 'oas30' | 'oas31';
export const DIALECTS: Dialect[] = ['swagger2', 'oas30', 'oas31'];

const item = {
  type: 'object',
  required: ['id', 'name'],
  properties: { id: { type: 'integer' }, name: { type: 'string' }, qty: { type: 'integer' } },
};
const itemInput = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1 }, qty: { type: 'integer', minimum: 1, default: 5 }, readonlyId: { type: 'integer', readOnly: true } },
};
const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };
const nodeSchema = { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/NODE' } } } };

type Json = Record<string, any>;

/** Equivalent endpoint set expressed in Swagger 2.0, OpenAPI 3.0.3 and OpenAPI 3.1.0. */
export function buildSpec(dialect: Dialect, o: { basePath?: string; extraPaths?: Json } = {}): Json {
  const s2 = dialect === 'swagger2';
  const defs = '#/' + (s2 ? 'definitions' : 'components/schemas');
  const ref = (n: string) => ({ $ref: `${defs}/${n}` });
  const fixRefs = (v: any): any => JSON.parse(JSON.stringify(v).replace(/"#\/NODE"/g, `"${defs}/Node"`));
  const schemas = { Item: item, ItemInput: itemInput, Error: errorSchema, Node: fixRefs(nodeSchema) };

  const json = (schema: Json) => (s2 ? { schema } : { content: { 'application/json': { schema } } });
  const body = (schema: Json, required = true) =>
    s2 ? { parameters: [{ in: 'body', name: 'body', required, schema }], consumes: ['application/json'] } : { requestBody: { required, content: { 'application/json': { schema } } } };
  const q = (name: string, schema: Json, extra: Json = {}) => (s2 ? { in: 'query', name, ...schema, ...extra } : { in: 'query', name, schema, ...extra });
  const err = { description: 'error', ...json(ref('Error')) };

  const paths: Json = {
    '/items': {
      post: { operationId: 'createItem', tags: ['items'], summary: 'Create an item', ...body(ref('ItemInput')), responses: { '201': { description: 'created', ...json(ref('Item')) }, default: err } },
    },
    '/items/{id}': {
      get: {
        operationId: 'getItem',
        tags: ['items'],
        summary: 'Get an item by id',
        parameters: [
          s2 ? { in: 'path', name: 'id', required: true, type: 'integer' } : { in: 'path', name: 'id', required: true, schema: { type: 'integer' } },
          q('tags', s2 ? { type: 'array', items: { type: 'string' }, collectionFormat: 'csv' } : { type: 'array', items: { type: 'string' } }, s2 ? {} : { style: 'form', explode: false }),
          q('flag', { type: 'boolean' }),
          s2 ? { in: 'header', name: 'X-Trace', type: 'string' } : { in: 'header', name: 'X-Trace', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok', ...json(ref('Item')) }, default: err },
      },
    },
    '/multi': {
      get: {
        operationId: 'multi',
        tags: ['serialization'],
        summary: 'Collection formats',
        parameters: [
          q('ids', s2 ? { type: 'array', items: { type: 'integer' }, collectionFormat: 'multi' } : { type: 'array', items: { type: 'integer' } }, s2 ? {} : { style: 'form', explode: true }),
          q('pipe', s2 ? { type: 'array', items: { type: 'string' }, collectionFormat: 'pipes' } : { type: 'array', items: { type: 'string' } }, s2 ? {} : { style: 'pipeDelimited', explode: false }),
          q('ssv', s2 ? { type: 'array', items: { type: 'string' }, collectionFormat: 'ssv' } : { type: 'array', items: { type: 'string' } }, s2 ? {} : { style: 'spaceDelimited', explode: false }),
          ...(s2 ? [] : [q('filter', { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }, { style: 'deepObject', explode: true })]),
        ],
        responses: { '200': { description: 'ok', ...json({ type: 'object' }) } },
      },
    },
    '/same': {
      get: {
        operationId: 'same',
        tags: ['serialization'],
        parameters: [q('token', { type: 'string' }), s2 ? { in: 'header', name: 'token', type: 'string' } : { in: 'header', name: 'token', schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/image': {
      get: { operationId: 'getImage', tags: ['files'], summary: 'JSON with embedded image', responses: { '200': { description: 'ok', ...json({ type: 'object', required: ['status'], properties: { status: { type: 'string' }, image: { type: 'string', format: 'byte' }, note: { type: 'string' } } }) } } },
    },
    '/download': {
      get: {
        operationId: 'download',
        tags: ['files'],
        summary: 'Binary download',
        ...(s2 ? { produces: ['application/octet-stream'] } : {}),
        responses: { '200': { description: 'ok', ...(s2 ? { schema: { type: 'file' } } : { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }) } },
      },
    },
    '/upload': {
      post: {
        operationId: 'upload',
        tags: ['files'],
        summary: 'Multipart upload',
        ...(s2
          ? { consumes: ['multipart/form-data'], parameters: [{ in: 'formData', name: 'file', type: 'file', required: true }, { in: 'formData', name: 'note', type: 'string' }] }
          : { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, note: { type: 'string' } } } } } } }),
        responses: { '200': { description: 'ok', ...json({ type: 'object' }) } },
      },
    },
    '/form': {
      post: {
        operationId: 'postForm',
        tags: ['serialization'],
        ...(s2
          ? { consumes: ['application/x-www-form-urlencoded'], parameters: [{ in: 'formData', name: 'tag', type: 'array', items: { type: 'string' }, collectionFormat: 'multi' }, { in: 'formData', name: 'n', type: 'integer' }] }
          : { requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { tag: { type: 'array', items: { type: 'string' } }, n: { type: 'integer' } } }, encoding: { tag: { style: 'form', explode: true } } } } } }),
        responses: { '200': { description: 'ok' } },
      },
    },
    '/login': {
      post: {
        operationId: 'login',
        tags: ['auth'],
        summary: 'Log in',
        ...body({ type: 'object', properties: { user: { type: 'string' }, pass: { type: 'string' } } }),
        responses: { '200': { description: 'ok', ...json({ type: 'object', properties: { token: { type: 'string' }, csrf: { type: 'string' } } }) }, '401': { description: 'bad credentials' } },
      },
    },
    '/me': {
      get: { operationId: 'me', tags: ['auth'], summary: 'Current user', security: [{ bearer: [] }], responses: { '200': { description: 'ok', ...json({ type: 'object', properties: { user: { type: 'string' } } }) }, '401': { description: 'unauthorized' }, '403': { description: 'forbidden' } } },
    },
    '/redirect': {
      get: { operationId: 'redirectGet', tags: ['redirect'], responses: { '200': { description: 'ok' }, '302': { description: 'found' } } },
      post: { operationId: 'redirectPost', tags: ['redirect'], ...body({ type: 'object' }, false), responses: { '200': { description: 'ok' }, '302': { description: 'found' }, '303': { description: 'see other' }, '307': { description: 'temporary' } } },
    },
    '/node': {
      get: { operationId: 'getNode', tags: ['recursive'], responses: { '200': { description: 'ok', ...json(ref('Node')) } } },
    },
    ...(o.extraPaths ?? {}),
  };

  const base: Json = s2
    ? { swagger: '2.0', info: { title: 'Fixture', version: '1.0.0' }, basePath: o.basePath ?? '/', paths, definitions: schemas, securityDefinitions: { bearer: { type: 'apiKey', in: 'header', name: 'Authorization' } } }
    : {
        openapi: dialect === 'oas30' ? '3.0.3' : '3.1.0',
        info: { title: 'Fixture', version: '1.0.0' },
        paths,
        components: { schemas, securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      };
  return base;
}
