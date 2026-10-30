const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

// Run against the installed Renovate package, not mock manager implementations.
const distDir = resolve(process.env.RENOVATE_TEST_DIST_DIR || '/usr/local/renovate/dist');
const configFile = join(__dirname, 'config.js');
const load = (file) => import(pathToFileURL(join(distDir, file)).href);

test('central config repairs real Bun manager dispatch', async (t) => {
  const { getParsedContent } = await load('workers/global/config/parse/util.js');
  const { GlobalConfig } = await load('config/global.js');
  const manager = await load('modules/manager/index.js');
  const managers = manager.getManagers();
  const originalBun = managers.get('bun');
  const originalArgv = process.argv[1];
  const originalGlobalConfig = GlobalConfig.get();
  GlobalConfig.set({ ...originalGlobalConfig, localDir: __dirname });
  process.argv[1] = join(distDir, 'renovate.js');

  try {
    await t.test('extracts updated Bun manifests after the actual config loader runs', async () => {
      // Exercise the missing-export case even after upstream gains an extractor.
      const { extractPackageFile: ignored, ...unpatchedBun } = originalBun;
      managers.set('bun', unpatchedBun);
      const content = JSON.stringify({
        packageManager: 'bun@1.4.3',
        dependencies: { astro: '7.4.3' },
      });
      assert.equal(await manager.extractPackageFile('bun', content, 'package.json', {}), null);

      const config = await getParsedContent(configFile);
      const result = await manager.extractPackageFile('bun', content, 'package.json', {});
      assert.ok(result.deps.some((dep) => dep.depName === 'astro' && dep.currentValue === '7.4.3'));
      assert.equal(managers.get('bun').extractAllPackageFiles, originalBun.extractAllPackageFiles);
      assert.equal(managers.get('bun').updateArtifacts, originalBun.updateArtifacts);
      assert.equal(config.platform, 'github');
      assert.equal(config.requireConfig, 'required');
      assert.equal(config.dependencyDashboardTitle, 'Renovate Dashboard');
      assert.equal(config.pruneStaleBranches, true);
    });

    await t.test('preserves an upstream-provided extractor and registry entry', async () => {
      const extractPackageFile = () => ({ deps: [] });
      const upstreamBun = { ...originalBun, extractPackageFile };
      managers.set('bun', upstreamBun);
      await getParsedContent(configFile);
      assert.equal(managers.get('bun'), upstreamBun);
      assert.equal(managers.get('bun').extractPackageFile, extractPackageFile);
    });

    await t.test('reports an incompatible runtime layout', async () => {
      process.argv[1] = __filename;
      await assert.rejects(getParsedContent(configFile), /Cannot apply the central Renovate Bun extractor workaround/);
    });
  } finally {
    managers.set('bun', originalBun);
    GlobalConfig.set(originalGlobalConfig);
    process.argv[1] = originalArgv;
  }
});
