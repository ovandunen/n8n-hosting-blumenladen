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
  const fn = new Function('$env', '$', 'items', code);
  return fn($env, $, items);
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
  const self = ctx.self ?? {
    helpers: {
      httpRequest: async () => {
        throw new Error('httpRequest not mocked');
      },
    },
  };
  const fn = new AsyncFunction('$env', '$', 'items', code);
  return fn.call(self, $env, $, items);
}
