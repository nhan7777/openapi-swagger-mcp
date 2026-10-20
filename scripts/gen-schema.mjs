// Regenerate config.schema.json from the Zod config schema. Run after `npm run build`.
// No `unrepresentable: 'any'`: an unsupported construct must fail generation instead of silently widening validation.
import fs from 'node:fs';
import { z } from 'zod';
import { ConfigSchema } from '../dist/config-schema.js';

const schema = z.toJSONSchema(ConfigSchema, { io: 'input', target: 'draft-2020-12', reused: 'ref' });
schema.title = 'openapi-swagger-mcp config';
fs.writeFileSync(new URL('../config.schema.json', import.meta.url), JSON.stringify(schema, null, 2) + '\n');
console.log('wrote config.schema.json');
