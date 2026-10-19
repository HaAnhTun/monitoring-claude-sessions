// D15: alerts have no outbound network code (webhooks are deferred, 03 10.4). A static scan of the folder: no file imports an HTTP,
// socket or DNS module or calls `fetch`. The scan itself is proven on small samples first, so an empty result means something.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process'];

/** The forbidden things a source text does: imports of network modules and calls of `fetch` (comments and strings aside). */
function networkUses(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const found: string[] = [];
  for (const name of FORBIDDEN_MODULES) {
    const module = new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"](?:node:)?${name}['"]`);
    if (module.test(code)) found.push(`import of ${name}`);
  }
  if (/(?<![\w.])fetch\s*\(/.test(code) || /globalThis\.fetch\b/.test(code)) found.push('fetch');
  if (/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/.test(code)) found.push('browser network API');
  return found;
}

describe('the scan', () => {
  it('finds each kind of network use', () => {
    expect(networkUses("import http from 'node:http';")).toEqual(['import of http']);
    expect(networkUses("import { request } from 'https';")).toEqual(['import of https']);
    expect(networkUses("const net = require('node:net');")).toEqual(['import of net']);
    expect(networkUses("import tls from 'node:tls'")).toEqual(['import of tls']);
    expect(networkUses("import dgram from 'node:dgram'")).toEqual(['import of dgram']);
    expect(networkUses("const mod = await import('node:http');")).toEqual(['import of http']);
    expect(networkUses('await fetch(url);')).toEqual(['fetch']);
    expect(networkUses('await globalThis.fetch(url);')).toEqual(['fetch']);
  });

  it('does not trip over words in comments, strings and similar names', () => {
    expect(networkUses("// import http from 'node:http'\nconst x = 1;")).toEqual([]);
    expect(networkUses('/* fetch(url) */ const fetchedAt = 1; refetch(2); const o = { prefetch(3) };')).toEqual([]);
    expect(networkUses("import { statSync } from 'node:fs';")).toEqual([]);
  });
});

describe('packages/engine/src/alerts', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));

  it('has source files to scan', () => {
    expect(files).toEqual(expect.arrayContaining(['rules.ts', 'evaluator.ts', 'service.ts']));
  });

  it.each(files.filter((name) => !name.endsWith('no-network.test.ts')))(
    '%s imports no network module and calls no fetch',
    (name) => {
      expect(networkUses(readFileSync(path.join(dir, name), 'utf8')), name).toEqual([]);
    },
  );
});
