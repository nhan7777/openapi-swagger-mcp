import fs from 'node:fs';
import vm from 'node:vm';

// Minimal DOM for executing the real inert-rendering UI, with no browser/network timing in unit tests.
class Element {
  attributes = new Map<string, string>();
  nodes: Array<Element | string> = [];
  parent?: Element;
  hidden = false;
  value = '';
  scrollTop = 0;
  listeners = new Map<string, Array<() => unknown>>();
  constructor(readonly tagName: string) {}
  get children(): Element[] { return this.nodes.filter((n): n is Element => n instanceof Element); }
  get firstChild(): Element | string | undefined { return this.nodes[0]; }
  get childNodes(): Array<Element | string> { return this.nodes; }
  get className(): string { return this.attributes.get('class') ?? ''; }
  set className(value: string) { this.attributes.set('class', value); }
  get textContent(): string { return this.nodes.map((n) => typeof n === 'string' ? n : n.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(value); }
  get classList() {
    return {
      add: (name: string) => { this.className = [...new Set([...this.className.split(' '), name])].join(' '); },
      remove: (name: string) => { this.className = this.className.split(' ').filter((c) => c !== name).join(' '); },
    };
  }
  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value);
    if (key === 'value') this.value = value;
    if (key === 'hidden') this.hidden = true;
  }
  removeAttribute(key: string): void {
    this.attributes.delete(key);
    if (key === 'hidden') this.hidden = false;
  }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  append(...nodes: Array<Element | string>): void {
    for (const n of nodes) {
      if (n instanceof Element) {
        if (n.parent) n.parent.nodes = n.parent.nodes.filter((old) => old !== n);
        n.parent = this;
      }
      this.nodes.push(n);
    }
  }
  replaceChildren(...nodes: Array<Element | string>): void {
    for (const n of this.children) n.parent = undefined;
    this.nodes = [];
    this.append(...nodes);
  }
  addEventListener(event: string, fn: () => unknown): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
  }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn(); }
  focus(): void {}
  querySelectorAll(selector: string): Element[] {
    const matches = (node: Element, simple: string): boolean => {
      if (simple.startsWith('.')) return node.className.split(' ').includes(simple.slice(1));
      if (simple.startsWith('#')) return node.getAttribute('id') === simple.slice(1);
      if (simple.startsWith('[')) {
        const inner = simple.slice(1, -1);
        const eq = inner.indexOf('=');
        if (eq < 0) return node.getAttribute(inner) !== null;
        const k = inner.slice(0, eq).trim();
        const v = inner.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
        return node.getAttribute(k) === v;
      }
      return node.tagName.toLowerCase() === simple.toLowerCase();
    };
    const out: Element[] = [];
    for (const child of this.children) {
      if (selector.split(',').some((s) => matches(child, s.trim()))) out.push(child);
      out.push(...child.querySelectorAll(selector));
    }
    return out;
  }
}

export function inspectorUi({ deferInput = false, initialTheme }: { deferInput?: boolean; initialTheme?: string } = {}) {
  const documentRoot = new Element('HTML');
  for (const id of ['notice', 'live-pill', 'live-text', 'live-toggle', 'theme-switcher', 'banner', 'filters', 'list', 'timeline-pane', 'timeline-counts', 'more', 'detail', 'layout', 'trace-session']) {
    const node = new Element('DIV');
    node.setAttribute('id', id);
    documentRoot.append(node);
  }
  const storage = new Map<string, string>();
  if (initialTheme) storage.set('oasm-inspector-theme', initialTheme);
  const copied: string[] = [];
  const pending: Array<{ path: string; resolve: (body: unknown) => void; reject: (e: Error) => void }> = [];
  const context = vm.createContext({
    document: {
      documentElement: documentRoot,
      createElement: (tag: string) => new Element(tag.toUpperCase()),
      getElementById: (id: string) => documentRoot.querySelectorAll(`#${id}`)[0],
      querySelectorAll: (selector: string) => documentRoot.querySelectorAll(selector),
      activeElement: null,
    },
    window: { addEventListener: () => {} },
    location: { hash: '', pathname: '/' },
    sessionStorage: { getItem: () => 'test-token', setItem: () => {} },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, String(v)); },
      removeItem: (k: string) => { storage.delete(k); },
    },
    navigator: {
      clipboard: {
        writeText: async (text: string) => { copied.push(String(text)); },
      },
    },
    URLSearchParams,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: (url: string) => {
      if (url === '/api/meta') return Promise.resolve({ ok: true, json: async () => ({ traceSessionId: 'test', services: [], limits: { pageBytes: 16, timelineLimit: 100 } }) });
      if (url.startsWith('/api/status')) return new Promise(() => {});
      const result = Promise.withResolvers<unknown>();
      if (!deferInput && /\/api\/calls\/[^/]+\/input-body/.test(url)) return Promise.resolve({ ok: true, json: async () => ({ stored: false }) });
      if (/\/api\/calls\/[^/]+\/(exchanges|auth-runs|policy-blocks)/.test(url)) return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      pending.push({ path: url, resolve: result.resolve, reject: result.reject });
      return result.promise.then((body) => ({ ok: true, json: async () => body }));
    },
  });
  const source = fs.readFileSync(new URL('../../src/inspector/ui/app.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  return {
    run: <T = unknown>(expression: string): T => vm.runInContext(expression, context) as T,
    pending,
    copied,
    storage,
    root: documentRoot,
    node: (id: string) => documentRoot.querySelectorAll(`#${id}`)[0]!,
    flush: async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); },
  };
}
