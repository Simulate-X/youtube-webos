import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import makeConfig from '../webpack.config.js';

test('acceptance version overlay affects staging only, not production assets', async () => {
  const bytes = await readFile(
    new URL('../assets/appinfo.json', import.meta.url),
  );
  const original = JSON.parse(bytes.toString());
  const config = makeConfig({
    modern: 'true',
    yttr: 'true',
    staging: 'true',
  })[0];
  const copy = config.plugins.find((plugin) => Array.isArray(plugin.patterns));
  const manifest = copy.patterns.find(
    (pattern) => pattern.to === 'appinfo.json',
  );
  const staged = JSON.parse(manifest.transform.transformer(bytes));
  assert.equal(staged.id, 'com.zui.webos.youtube.staging');
  assert.equal(staged.version, '0.8.5');
  assert.equal(staged.title, 'ZUI YouTube STAGING');
  assert.equal(original.id, 'youtube.leanback.v4');
  assert.equal(original.version, '0.8.4');
  const production = makeConfig({ modern: 'true', yttr: 'true' })[0];
  const productionCopy = production.plugins.find((plugin) =>
    Array.isArray(plugin.patterns),
  );
  assert.equal(
    productionCopy.patterns.some((pattern) => pattern.transform),
    false,
  );
  assert.equal(
    JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
      .version,
    '0.8.4',
  );
});
