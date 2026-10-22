// OpenAPI documents for the synthetic demo backend. Data is invented; nothing here refers to a real system.

const error = { type: 'object', properties: { error: { type: 'string' }, received: {} } };
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });

/** `demo-shop`: anonymous orders API with one deliberately large response. */
export function shopSpec(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: { title: 'Demo shop (synthetic)', version: '1.0.0', description: 'Synthetic data served on loopback by `openapi-swagger-mcp demo`.' },
    paths: {
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          tags: ['orders'],
          summary: 'Get order details by id',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer', minimum: 1 } }],
          responses: { '200': { description: 'order', ...json({ $ref: '#/components/schemas/Order' }) }, '404': { description: 'no such order', ...json(error) } },
        },
      },
      '/orders': {
        post: {
          operationId: 'createOrder',
          tags: ['orders'],
          summary: 'Create an order (returns 422 for invalid input, echoing what was received)',
          requestBody: { required: true, ...json({ $ref: '#/components/schemas/OrderInput' }) },
          responses: { '201': { description: 'created', ...json({ $ref: '#/components/schemas/Order' }) }, '422': { description: 'invalid order', ...json(error) } },
        },
      },
      '/reports/large': {
        get: {
          operationId: 'getLargeReport',
          tags: ['reports'],
          summary: 'Large sales report with an embedded base64 attachment',
          responses: {
            '200': {
              description: 'report',
              ...json({
                type: 'object',
                required: ['rows', 'attachment'],
                properties: {
                  rows: { type: 'array', items: { type: 'object', properties: { day: { type: 'string' }, orders: { type: 'integer' }, note: { type: 'string' } } } },
                  attachment: { type: 'string', format: 'byte' },
                },
              }),
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Order: {
          type: 'object',
          required: ['id', 'item', 'quantity', 'status'],
          properties: { id: { type: 'integer' }, item: { type: 'string' }, quantity: { type: 'integer' }, status: { type: 'string', enum: ['new', 'shipped'] } },
        },
        OrderInput: {
          type: 'object',
          required: ['item', 'quantity'],
          additionalProperties: false,
          properties: { item: { type: 'string', minLength: 1 }, quantity: { type: 'integer', minimum: 1 } },
        },
      },
    },
  };
}

/** `demo-account`: login, rotating refresh and a bearer-protected endpoint. */
export function accountSpec(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: { title: 'Demo account (synthetic)', version: '1.0.0' },
    paths: {
      '/session/login': {
        post: {
          operationId: 'login',
          tags: ['session'],
          summary: 'Log in with the demo user',
          requestBody: { required: true, ...json({ type: 'object', required: ['user', 'pass'], properties: { user: { type: 'string' }, pass: { type: 'string' } } }) },
          responses: {
            '200': { description: 'tokens', ...json({ type: 'object', properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' } } }) },
            '401': { description: 'bad credentials', ...json(error) },
          },
        },
      },
      '/session/refresh': {
        post: {
          operationId: 'refreshSession',
          tags: ['session'],
          summary: 'Exchange the refresh token (rotates it)',
          requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['refresh_token'], properties: { refresh_token: { type: 'string' } } } } } },
          responses: {
            '200': { description: 'tokens', ...json({ type: 'object', properties: { access_token: { type: 'string' }, refresh_token: { type: 'string' } } }) },
            '401': { description: 'refresh token rejected', ...json(error) },
          },
        },
      },
      '/me': {
        get: {
          operationId: 'getMe',
          tags: ['session'],
          summary: 'Current demo user',
          security: [{ bearer: [] }],
          responses: { '200': { description: 'user', ...json({ type: 'object', properties: { user: { type: 'string' } } }) }, '401': { description: 'missing or expired token', ...json(error) } },
        },
      },
    },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  };
}
