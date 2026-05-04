/**
 * Run n8n Code node bodies (sync or async) with injected $env, $, items, this.helpers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..', 'src', 'nodes');

export function readNodeSource(fileName) {
  return fs.readFileSync(path.join(srcDir, fileName), 'utf8');
}

/** @param {string} fileName @param {{ $env?: object, $?: function, items?: { json: object }[] }} ctx */
export function runSyncCodeNode(fileName, ctx = {}) {
  const code = readNodeSource(fileName);
  const $env = ctx.$env ?? {};
  const $ = ctx.$ ?? (() => ({ first: () => ({ json: {} }) }));
  const items = ctx.items ?? [{ json: {} }];
  const item0 = items[0] ?? { json: {} };
  const $input = ctx.$input ?? { item: item0 };
  const fn = new Function('$env', '$', 'items', '$input', code);
  const r = fn($env, $, items, $input);
  // n8n runOnceForEachItem returns a single { json } object; tests expect an items[] array.
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object' && 'json' in r) return [r];
  return [{ json: r }];
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * @param {string} fileName
 * @param {{
 *   $env?: object,
 *   $?: function,
 *   items?: { json: object }[],
 *   self?: { helpers: { httpRequest: Function } },
 * }} ctx
 */
export async function runAsyncCodeNode(fileName, ctx = {}) {
  const code = readNodeSource(fileName);
  const $env = ctx.$env ?? {};
  const $ = ctx.$ ?? (() => ({ first: () => ({ json: {} }) }));
  const items = ctx.items ?? [{ json: {} }];
  const item0 = items[0] ?? { json: {} };
  const $input = ctx.$input ?? { item: item0 };
  const self = ctx.self ?? {
    helpers: {
      httpRequest: async () => {
        throw new Error('httpRequest not mocked');
      },
    },
  };
  /** n8n Code sandbox exposes `$http`; map tests' `helpers.httpRequest` mocks to `{ data }` like n8n. */
  const $http =
    ctx.$http ?? ((opts) => Promise.resolve(self.helpers.httpRequest(opts)).then((payload) => ({ data: payload })));

  const fn = new AsyncFunction('$env', '$', 'items', '$http', '$input', code);
  return fn.call(self, $env, $, items, $http, $input);
}
