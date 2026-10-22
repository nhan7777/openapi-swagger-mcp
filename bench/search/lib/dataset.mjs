// Dataset format 1 (see ../dataset-format.md): structural checks shared by make-manifest, validate-dataset and run.mjs.
// This module never imports product code and never runs the search engine.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const CATEGORIES = ['exact_path', 'exact_operation_id', 'typo', 'acronym', 'vi', 'vi_no_diacritics', 'en', 'cjk', 'paraphrase_no_alias', 'paraphrase_alias', 'response_field', 'nested_schema', 'multi_service', 'no_result'];
export const POSITIVE = CATEGORIES.filter((c) => c !== 'no_result');
export const LANGS = ['en', 'vi', 'zh', 'ja', 'ko', 'mixed'];
export const SCOPES = ['identifier', 'text', 'parameter', 'requestField', 'responseField', 'schema'];
export const KINDS = ['heldout', 'dev2'];
const NON_ENGLISH = new Set(['vi', 'zh', 'ja', 'ko']);
/** `no_result` classes counted as near-misses: everything except plain out-of-domain and unprocessable input. */
export const NOT_NEAR_MISS = new Set(['out-of-domain', 'unprocessable']);

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Accent-stripping fold for the absence check. Deliberately independent of the product tokenizer and stricter than it
 *  (every combining mark is removed), so a concept that passes here is absent under the product fold too. */
export const foldForAbsence = (s) => s.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').normalize('NFC');

const SAFE_REL = (p) => typeof p === 'string' && p !== '' && !path.isAbsolute(p) && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === '' || s === '.');

/** Every regular file below `dir` (posix relative names), except manifest.json. Symlinks and special files are problems. */
export function listFiles(dir, problems) {
  const out = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isSymbolicLink()) problems.push(`${r}: symbolic links are not allowed`);
      else if (st.isDirectory()) walk(r);
      else if (st.isFile()) {
        if (r !== 'manifest.json') out.push(r);
      } else problems.push(`${r}: not a regular file`);
    }
  };
  walk('');
  return out;
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const RULE_KEYS = new Set(['method', 'path', 'operationId', 'tag']);

export function checkConfig(config, dir, problems) {
  if (!isObj(config)) return void problems.push('config.json: must be an object');
  for (const k of Object.keys(config)) if (!['version', 'services', 'search'].includes(k)) problems.push(`config.json: key "${k}" is not allowed (only version, services, search)`);
  if (config.version !== 1) problems.push('config.json: version must be 1');
  if (!isObj(config.services) || Object.keys(config.services).length === 0) return void problems.push('config.json: services must be a non-empty object');
  const ports = new Set();
  for (const [id, s] of Object.entries(config.services)) {
    const at = `config.json: services.${id}`;
    if (!isObj(s)) {
      problems.push(`${at}: must be an object`);
      continue;
    }
    for (const k of Object.keys(s)) if (!['baseUrl', 'spec', 'operations'].includes(k)) problems.push(`${at}: key "${k}" is not allowed (only baseUrl, spec, operations)`);
    if (typeof s.baseUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(s.baseUrl)) problems.push(`${at}.baseUrl: must look like http://127.0.0.1:<port>`);
    else if (ports.has(s.baseUrl)) problems.push(`${at}.baseUrl: duplicate of another service`);
    else ports.add(s.baseUrl);
    const file = isObj(s.spec) && isObj(s.spec.source) && Object.keys(s.spec).length === 1 && Object.keys(s.spec.source).length === 1 ? s.spec.source.file : undefined;
    if (!SAFE_REL(file)) problems.push(`${at}.spec: must be { "source": { "file": "<relative path inside the dataset>" } }`);
    else if (!fs.existsSync(path.join(dir, file))) problems.push(`${at}.spec: ${file} does not exist`);
    if (s.operations !== undefined) {
      if (!isObj(s.operations) || Object.keys(s.operations).some((k) => !['include', 'exclude'].includes(k))) problems.push(`${at}.operations: only include and exclude are allowed`);
      else
        for (const list of ['include', 'exclude'])
          for (const [i, r] of (s.operations[list] ?? []).entries())
            if (!isObj(r) || Object.keys(r).length === 0 || Object.keys(r).some((k) => !RULE_KEYS.has(k))) problems.push(`${at}.operations.${list}[${i}]: a rule has one or more of method, path, operationId, tag`);
    }
  }
  if (config.search !== undefined) {
    if (!isObj(config.search) || Object.keys(config.search).some((k) => k !== 'aliases')) problems.push('config.json: search may only contain aliases (search.limits is forbidden: datasets run with the product defaults)');
    else
      for (const [i, g] of (config.search.aliases ?? []).entries()) {
        if (!isObj(g) || !Array.isArray(g.terms) || g.terms.length < 2 || g.terms.length > 16 || g.terms.some((t) => typeof t !== 'string' || t === '' || t.length > 100)) problems.push(`config.json: search.aliases[${i}].terms must be 2-16 non-empty strings`);
        if (isObj(g) && g.services !== undefined && (!Array.isArray(g.services) || g.services.some((x) => !(x in config.services)))) problems.push(`config.json: search.aliases[${i}].services must name configured services`);
        if (isObj(g) && Object.keys(g).some((k) => !['terms', 'services'].includes(k))) problems.push(`config.json: search.aliases[${i}] has an unknown key`);
      }
  }
}

export function checkRows(rows, manifest, config, problems) {
  const ids = new Set();
  const services = isObj(config?.services) ? config.services : {};
  for (const r of rows) {
    const at = `${r.id ?? '<no id>'}`;
    const bad = (m) => problems.push(`${at}: ${m}`);
    const known = ['id', 'batch', 'category', 'lang', 'query', 'relevant', 'service', 'fields', 'requiresAlias', 'class', 'absentConcept', 'scopeMismatch', 'bothDirections', 'weak'];
    for (const k of Object.keys(r)) if (!known.includes(k)) bad(`unknown field "${k}"`);
    if (typeof r.id !== 'string' || r.id === '') bad('id must be a non-empty string');
    else if (ids.has(r.id)) bad('duplicate id');
    else ids.add(r.id);
    if (r.batch !== manifest.batch) bad(`batch must equal manifest.batch (${manifest.batch})`);
    if (!CATEGORIES.includes(r.category)) bad(`unknown category "${r.category}"`);
    if (!LANGS.includes(r.lang)) bad(`lang must be one of ${LANGS.join(', ')}`);
    if (typeof r.query !== 'string' || r.query === '' || r.query.length > 500) bad('query must be a string of 1-500 characters');
    if (!Array.isArray(r.relevant)) bad('relevant must be an array');
    else {
      for (const [i, e] of r.relevant.entries()) {
        if (!isObj(e) || typeof e.service !== 'string' || typeof e.operation !== 'string' || ![1, 2].includes(e.grade)) bad(`relevant[${i}] needs service, operation and grade 1 or 2`);
        else if (!(e.service in services)) bad(`relevant[${i}]: service "${e.service}" is not configured`);
        else if (r.service !== undefined && e.service !== r.service) bad(`relevant[${i}]: service differs from the row's service`);
      }
      if (r.category === 'no_result' && r.relevant.length !== 0) bad('no_result rows have relevant: []');
      if (r.category !== 'no_result' && !r.relevant.some((e) => e?.grade === 2)) bad('a positive row needs at least one grade 2 entry');
    }
    if (r.service !== undefined && !(r.service in services)) bad(`service "${r.service}" is not configured`);
    if (r.fields !== undefined && (!Array.isArray(r.fields) || r.fields.length === 0 || r.fields.some((f) => !SCOPES.includes(f)))) bad(`fields must be a non-empty subset of ${SCOPES.join(', ')}`);
    if (r.requiresAlias !== undefined && typeof r.requiresAlias !== 'boolean') bad('requiresAlias must be a boolean');
    if (r.category === 'paraphrase_alias' && r.requiresAlias !== true) bad('paraphrase_alias rows set requiresAlias: true');
    if (r.category === 'paraphrase_no_alias' && r.requiresAlias === true) bad('paraphrase_no_alias rows must not require aliases');
    if (r.category === 'no_result') {
      if (typeof r.class !== 'string' || r.class === '') bad('no_result rows need class');
      if (typeof r.absentConcept !== 'string' || r.absentConcept === '') bad('no_result rows need absentConcept');
    } else if (r.class !== undefined || r.absentConcept !== undefined || r.scopeMismatch !== undefined) bad('class, absentConcept and scopeMismatch belong to no_result rows');
    if (r.scopeMismatch !== undefined && (r.scopeMismatch !== true || r.fields === undefined)) bad('scopeMismatch must be true and the row needs fields');
  }
}

/** Counts as in manifest.counts. */
export function countRows(rows) {
  const perCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const noResultByClass = {};
  for (const r of rows) {
    if (r.category in perCategory) perCategory[r.category]++;
    if (r.category === 'no_result' && typeof r.class === 'string') noResultByClass[r.class] = (noResultByClass[r.class] ?? 0) + 1;
  }
  return { total: rows.length, perCategory, noResultByClass: Object.fromEntries(Object.entries(noResultByClass).sort(([a], [b]) => (a < b ? -1 : 1))) };
}

export function checkQuotas(rows, kind, problems) {
  const c = countRows(rows);
  const perPositive = kind === 'heldout' ? 15 : 8;
  const noResultMin = kind === 'heldout' ? 60 : 64;
  for (const cat of POSITIVE) if (c.perCategory[cat] < perPositive) problems.push(`quota: ${cat} has ${c.perCategory[cat]} rows, needs at least ${perPositive}`);
  const nr = rows.filter((r) => r.category === 'no_result');
  if (nr.length < noResultMin) problems.push(`quota: no_result has ${nr.length} rows, needs at least ${noResultMin}`);
  if (nr.length > 0) {
    const near = nr.filter((r) => !NOT_NEAR_MISS.has(r.class)).length;
    if (near / nr.length < (kind === 'heldout' ? 0.4 : 0.5)) problems.push(`quota: near-miss no_result is ${near}/${nr.length}, needs at least ${kind === 'heldout' ? '40' : '50'} percent (classes other than out-of-domain and unprocessable)`);
    const unproc = nr.filter((r) => r.class === 'unprocessable').length;
    if (unproc / nr.length > 0.1) problems.push(`quota: unprocessable no_result is ${unproc}/${nr.length}, at most 10 percent`);
    const ne = nr.filter((r) => NON_ENGLISH.has(r.lang)).length;
    if (ne / nr.length < 0.25) problems.push(`quota: non-English no_result is ${ne}/${nr.length}, needs at least 25 percent`);
  }
  if (kind === 'heldout') {
    const ms = rows.filter((r) => r.category === 'multi_service' && r.service !== undefined).length;
    if (ms < 6) problems.push(`quota: multi_service rows with service: ${ms}, needs at least 6`);
    const lang = rows.filter((r) => NON_ENGLISH.has(r.lang)).length;
    if (rows.length > 0 && lang / rows.length < 0.3) problems.push(`quota: vi/zh/ja/ko rows are ${lang}/${rows.length}, needs at least 30 percent`);
    const fieldRows = rows.filter((r) => r.category === 'response_field' || r.category === 'nested_schema');
    const dirRows = fieldRows.filter((r) => r.fields?.some((f) => f === 'requestField' || f === 'schema') || r.bothDirections === true).length;
    if (fieldRows.length > 0 && dirRows / fieldRows.length < 0.25) problems.push(`quota: response_field/nested_schema rows using requestField or schema scope: ${dirRows}/${fieldRows.length}, needs at least 25 percent`);
  }
}

/**
 * Read and check a dataset directory. `problems` is empty when the dataset is acceptable. `expectedKind` and
 * `commitment` (sha256 hex of manifest.json bytes) are optional extra requirements.
 */
export function loadDataset(dir, { expectedKind, commitment } = {}) {
  const problems = [];
  const out = { dir, problems, manifest: undefined, manifestHash: undefined, config: undefined, rows: [] };
  const mpath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mpath)) {
    problems.push('manifest.json: missing');
    return out;
  }
  const mbytes = fs.readFileSync(mpath);
  out.manifestHash = sha256(mbytes);
  if (commitment !== undefined && out.manifestHash !== commitment) problems.push(`manifest.json: sha256 ${out.manifestHash.slice(0, 12)}... does not match the commitment`);
  let m;
  try {
    m = JSON.parse(mbytes.toString('utf8'));
  } catch {
    problems.push('manifest.json: not valid JSON');
    return out;
  }
  out.manifest = m;
  if (!isObj(m) || m.format !== 1) problems.push('manifest.json: format must be 1');
  if (!KINDS.includes(m.kind)) problems.push(`manifest.json: kind must be one of ${KINDS.join(', ')}`);
  else if (expectedKind !== undefined && m.kind !== expectedKind) problems.push(`manifest.json: kind is ${m.kind}, expected ${expectedKind}`);
  if (typeof m.batch !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(m.batch)) problems.push('manifest.json: batch must match [A-Za-z0-9._-]{1,64}');
  if (m.corpusVersion !== 1) problems.push('manifest.json: corpusVersion must be 1');
  for (const k of ['queries', 'config']) if (!SAFE_REL(m[k])) problems.push(`manifest.json: ${k} must be a relative file name`);
  if (!isObj(m.files)) {
    problems.push('manifest.json: files must be an object');
    return out;
  }
  const onDisk = listFiles(dir, problems);
  for (const f of onDisk) if (!(f in m.files)) problems.push(`${f}: present in the directory but not listed in manifest.files`);
  for (const [f, h] of Object.entries(m.files)) {
    if (!SAFE_REL(f)) problems.push(`manifest.files: unsafe path "${f}"`);
    else if (!onDisk.includes(f)) problems.push(`${f}: listed in manifest.files but missing`);
    else if (sha256(fs.readFileSync(path.join(dir, f))) !== h) problems.push(`${f}: sha256 differs from manifest.files`);
  }
  for (const k of ['queries', 'config']) if (SAFE_REL(m[k]) && !(m[k] in m.files)) problems.push(`manifest.json: ${k} file ${m[k]} is not listed in files`);
  if (problems.length > 0 && !SAFE_REL(m.config)) return out;

  if (SAFE_REL(m.config) && fs.existsSync(path.join(dir, m.config))) {
    try {
      out.config = JSON.parse(fs.readFileSync(path.join(dir, m.config), 'utf8'));
    } catch {
      problems.push(`${m.config}: not valid JSON`);
    }
  }
  if (out.config !== undefined) checkConfig(out.config, dir, problems);

  if (SAFE_REL(m.queries) && fs.existsSync(path.join(dir, m.queries))) {
    const text = fs.readFileSync(path.join(dir, m.queries), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) problems.push(`${m.queries}: must not start with a byte order mark`);
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    lines.forEach((line, i) => {
      if (line.trim() === '') return void problems.push(`${m.queries}:${i + 1}: blank line`);
      try {
        const r = JSON.parse(line);
        if (!isObj(r)) problems.push(`${m.queries}:${i + 1}: not an object`);
        else out.rows.push(r);
      } catch {
        problems.push(`${m.queries}:${i + 1}: not valid JSON`);
      }
    });
    checkRows(out.rows, m, out.config, problems);
    if (isObj(m.counts)) {
      const actual = countRows(out.rows);
      if (!isDeepStrictEqual(actual, m.counts)) problems.push('manifest.json: counts differ from the counts recomputed from the queries file');
    } else problems.push('manifest.json: counts missing');
  }
  return out;
}
