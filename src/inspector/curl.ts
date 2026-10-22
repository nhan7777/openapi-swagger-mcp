import type { ExchangePurpose, ObservedField, RequestObservation } from '../trace/types.js';
import { isSecretName } from './secrets.js';

// Builds a copyable curl command from a recorded request observation. Pure: no serializer, no credential store, no
// file access, nothing is sent or executed. Secrets become environment-variable references; bodies are NEVER inlined.

export interface CurlOutput {
  command: string;
  warnings: string[];
  placeholders: Array<{ env: string; for: string }>;
}

/** POSIX single-quote quoting: the result is always exactly one shell word with no expansion. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Headers curl derives itself; copying recorded values would produce a wrong request. */
const CURL_MANAGED: Record<string, true> = { host: true, 'content-length': true, 'transfer-encoding': true, connection: true };
const SAFE_METHODS: Record<string, true> = { GET: true, HEAD: true, OPTIONS: true };

type Piece = { lit: string } | { env: string };

/** Same decision the masking layer makes: credential-sourced, unrecorded, or secret-looking. */
const isSecretField = (f: ObservedField, kind: 'header' | 'query'): boolean =>
  f.source === 'credential' || f.source === 'jar' || f.value === undefined || isSecretName(f.name, kind);

const decodeName = (s: string): string | undefined => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return undefined;
  }
};

export function buildCurl(req: RequestObservation, ctx: { purpose: ExchangePurpose; truncated?: boolean }): CurlOutput {
  const warnings: string[] = [];
  const placeholders: CurlOutput['placeholders'] = [];
  const usedEnv = new Set<string>();

  const env = (kind: string, name: string, label: string): string => {
    const core = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'FIELD';
    const base = `OASM_${kind}${core}`;
    let candidate = base;
    for (let n = 2; usedEnv.has(candidate); n++) candidate = `${base}_${n}`;
    usedEnv.add(candidate);
    placeholders.push({ env: candidate, for: label });
    return candidate;
  };

  const args: string[] = [];
  const method = req.method.toUpperCase();
  args.push(method === 'HEAD' ? '--head' : `-X ${shellQuote(method)}`, '--globoff');

  // ---- headers
  let verbatimHeader = false;
  const skippedTransport: string[] = [];
  for (const h of req.headers) {
    const lower = h.name.toLowerCase();
    if (lower === 'cookie' || CURL_MANAGED[lower] === true) continue;
    if (h.value === undefined && h.source === 'transport') {
      skippedTransport.push(h.name);
    } else if (isSecretField(h, 'header')) {
      args.push(`-H ${shellQuote(`${h.name}: `)}"$${env('', h.name, `header ${h.name}`)}"`);
    } else {
      verbatimHeader = true;
      args.push(`-H ${shellQuote(h.value === '' ? `${h.name};` : `${h.name}: ${h.value}`)}`);
    }
  }
  if (req.cookies.length > 0 || req.headers.some((h) => h.name.toLowerCase() === 'cookie')) {
    args.push(`-H ${shellQuote('cookie: ')}"$${env('', 'cookie', 'all cookies')}"`);
  }

  // ---- body: never inlined, whatever its size or type
  if (req.body) {
    args.push('--data-binary @REQUEST_BODY_FILE');
    warnings.push('Save the request body you want to send to a local file and replace REQUEST_BODY_FILE with its path. The inspector never copies bodies into the command; review the file for sensitive data before sharing it.');
    if (req.body.volatile === 'multipart_boundary') warnings.push('The multipart boundary changes on every build: the boundary in the content-type header must match the one inside your body file.');
    if (req.body.files?.length) warnings.push(`Uploaded file contents are not available to the inspector (${req.body.files.map((f) => f.basename).join(', ')}).`);
  }

  // ---- URL: unchanged text for non-secret parts; credential values are placeholders, never re-encoded
  const noFragment = req.url.split('#')[0]!;
  const qAt = noFragment.indexOf('?');
  const base = qAt < 0 ? noFragment : noFragment.slice(0, qAt);
  const rawQuery = qAt < 0 ? undefined : noFragment.slice(qAt + 1);
  const segments = rawQuery === undefined || rawQuery === '' ? [] : rawQuery.split('&');
  const matches =
    segments.length === req.query.length &&
    segments.every((seg, i) => {
      const rawName = seg.split('=')[0]!;
      return rawName === req.query[i]!.name || decodeName(rawName) === req.query[i]!.name;
    });
  const pieces: Piece[] = [{ lit: base }];
  if (matches) {
    let sawCredentialQuery = false;
    segments.forEach((seg, i) => {
      const eq = seg.indexOf('=');
      const lead = i === 0 ? '?' : '&';
      if (eq >= 0 && isSecretField(req.query[i]!, 'query')) {
        sawCredentialQuery = true;
        pieces.push({ lit: `${lead}${seg.slice(0, eq + 1)}` }, { env: env('QUERY_', req.query[i]!.name, `query parameter ${req.query[i]!.name}`) });
      } else pieces.push({ lit: `${lead}${seg}` });
    });
    if (sawCredentialQuery) warnings.push('Query credential values must be percent-encoded exactly like the original request. The inspector does not observe how they were encoded: paste the already-encoded value.');
  } else {
    pieces.push({ lit: '?' }, { env: env('', 'QUERY', 'the whole query string') });
    warnings.push('The query string could not be matched to the recorded parameters, so exact reproduction is declined: the whole query is replaced by $OASM_QUERY (already percent-encoded, without the leading "?").');
  }
  let url = '';
  let literal = '';
  for (const p of pieces) {
    if ('lit' in p) literal += p.lit;
    else {
      url += `${literal ? shellQuote(literal) : ''}"$${p.env}"`;
      literal = '';
    }
  }
  if (literal || !url) url += shellQuote(literal);
  args.push(url);

  // ---- warnings
  const isWrite = SAFE_METHODS[method] !== true;
  if (isWrite) warnings.unshift('This is a write request: running the command sends it again.');
  if (ctx.purpose === 'auth_recipe') warnings.push('This URL is the recipe template: rendered values and template secrets were not recorded.');
  if (verbatimHeader) warnings.push('Header values not recognised as secrets were copied verbatim: review them before sharing the command.');
  if (skippedTransport.length) warnings.push(`Headers added by the HTTP client with no observed value were omitted: ${skippedTransport.join(', ')}.`);
  if (req.transportAdded.length) warnings.push(`The HTTP client may have added headers that were not observed: ${req.transportAdded.join(', ')}.`);
  if (ctx.truncated || req.headersTruncated) warnings.push('The recorded request is truncated: some headers or parameters may be missing from the command.');
  warnings.push('curl adds its own default headers (user-agent, accept, host, ...): the command does not reproduce the request byte for byte.');

  const command = `${isWrite ? '# write request: re-running sends it again\n' : ''}curl ${args.join(' \\\n  ')}`;
  return { command, warnings, placeholders };
}
