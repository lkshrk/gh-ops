const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { after, before, test } = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = resolve(__dirname, '..');
const distDir = resolve(process.env.RENOVATE_TEST_DIST_DIR || '/usr/local/renovate/dist');
const load = (file) => import(pathToFileURL(join(distDir, file)).href);
let runtime;
let originalPresetLoader;
let fixtures;

before(async () => {
  const runtimeRequire = createRequire(join(dirname(distDir), 'package.json'));
  const JSON5 = runtimeRequire('json5');
  const [defaults, presets, rules, branchNames, branches, manager, matching, config, global, names] = await Promise.all([
    load('config/defaults.js'),
    load('config/presets/index.js'),
    load('util/package-rules/index.js'),
    load('workers/repository/updates/branch-name.js'),
    load('workers/repository/updates/generate.js'),
    load('modules/manager/index.js'),
    load('workers/repository/extract/file-match.js'),
    load('config/index.js'),
    load('config/global.js'),
    load('workers/repository/extract/manager-files.js'),
  ]);
  runtime = { defaults, presets, rules, branchNames, branches, manager, matching, config };
  global.GlobalConfig.set({ localDir: repoRoot });
  originalPresetLoader = presets.presetSources.github.load;
  presets.presetSources.github.load = async () => ({
    getPreset: async ({ repo, presetPath, presetName }) => {
      assert.equal(repo, 'lkshrk/gh-ops', 'preset tests must not access external repositories');
      const file = join(repoRoot, presetPath || '', presetName);
      assert.ok(file.startsWith(join(repoRoot, 'renovate', 'presets') + '/'));
      return JSON5.parse(readFileSync(file, 'utf8'));
    },
  });

  const workflow = [
    'name: group fixtures', 'on: push', 'jobs:', '  test:', '    runs-on: ubuntu-latest',
    '    container: mcr.microsoft.com/playwright:v1.64.1-jammy',
    '    services:', '      browser:', '        image: mcr.microsoft.com/playwright:v1.64.1-jammy',
    '    steps:', '      - uses: actions/setup-node@v7', '        with:', '          node-version: 24',
    '      - uses: oven-sh/setup-bun@v2', '        with:', '          bun-version: 1.4.3',
  ].join('\n');
  const dockerfile = [
    'FROM node:24-alpine AS node', 'FROM oven/bun:1.4.3-alpine AS bun',
    'FROM docker.io/library/node:24-alpine AS officialAlias',
    'FROM kindest/node:v1.34.1 AS cluster',
    'FROM mcr.microsoft.com/playwright:v1.64.1-jammy AS browser', 'FROM redis:7-alpine',
  ].join('\n');
  const compose = [
    'services:', '  node:', '    image: node:24-alpine',
    '  bun:', '    image: oven/bun:1.4.3-alpine',
    '  browser:', '    image: mcr.microsoft.com/playwright:v1.64.1-jammy',
  ].join('\n');
  const packageJson = JSON.stringify({
    name: 'group-fixtures',
    packageManager: 'bun@1.4.3',
    dependencies: {
      '@sveltejs/kit': '2.61.0', '@sveltejs/adapter-node': '5.5.7', '@sveltejs/adapter-auto': '8.0.0',
      '@sveltejs/vite-plugin-svelte': '7.0.0', '@sveltejs/vite-plugin-svelte-inspector': '5.0.0',
      '@sveltejs/enhanced-img': '0.11.0', svelte: '5.55.4', vite: '8.0.8', react: '19.2.0',
    },
    devDependencies: {
      '@playwright/test': '1.64.1', playwright: '1.64.1', 'playwright-core': '1.64.1',
      '@playwright/browser-chromium': '1.64.1', '@playwright/mcp': '0.0.50',
      '@playwright/experimental-ct-svelte': '1.64.1',
    },
  });
  fixtures = [];
  for (const [managerName, packageFile, content] of [
    ['github-actions', '.github/workflows/fixture.yml', workflow],
    ['dockerfile', 'Dockerfile', dockerfile],
    ['docker-compose', 'compose.yml', compose],
    ['bun', 'package.json', packageJson],
  ]) {
    let result;
    if (managerName === 'bun') {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'renovate-group-fixture-'));
      const originalConfig = global.GlobalConfig.get();
      try {
        writeFileSync(join(fixtureRoot, packageFile), content);
        writeFileSync(join(fixtureRoot, 'bun.lock'), '{"lockfileVersion":1,"workspaces":{},"packages":{}}');
        global.GlobalConfig.set({ ...originalConfig, localDir: fixtureRoot });
        const packageFiles = await manager.extractAllPackageFiles('bun', {}, ['package.json', 'bun.lock']);
        assert.equal(packageFiles.length, 1);
        result = packageFiles[0];
      } finally {
        global.GlobalConfig.set(originalConfig);
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    } else result = await manager.extractPackageFile(managerName, content, packageFile, {});
    assert.ok(result?.deps.length, 'real extractor produced dependencies for ' + managerName);
    for (const dep of result.deps) names.normalizeDepNames(dep);
    fixtures.push(...result.deps.map((dep) => ({ ...dep, manager: managerName, packageFile })));
  }
});

after(() => {
  if (runtime) runtime.presets.presetSources.github.load = originalPresetLoader;
});

async function profile(name, extra = {}) {
  const resolved = await runtime.presets.resolveConfigPresets({
    extends: ['github>lkshrk/gh-ops//renovate/presets/' + name + '.json5'],
    ...extra,
  });
  return resolved.config;
}

async function update(config, dep, updateType = 'patch', repository = 'webdev-harke/pizzeria-riva') {
  return runtime.rules.applyPackageRules({
    ...structuredClone(runtime.defaults.getConfig()),
    ...structuredClone(config),
    repository,
    ...dep,
    updateType,
    isMajor: updateType === 'major',
    isMinor: updateType === 'minor',
    isPatch: updateType === 'patch',
    newValue: '26.0.0',
    newVersion: '26.0.0',
    newMajor: 26,
    newMinor: 0,
    pendingChecks: false,
  });
}

test('uses the deployed extractor identifiers instead of assumed runtime datasources', () => {
  const node = fixtures.find((dep) => dep.manager === 'github-actions' && dep.depName === 'node');
  assert.equal(node.datasource, 'github-releases');
  assert.equal(node.packageName, 'actions/node-versions');
  const bun = fixtures.find((dep) => dep.manager === 'github-actions' && dep.depName === 'bun');
  assert.equal(bun.datasource, 'npm');
  assert.equal(bun.packageName, 'bun');
  assert.ok(fixtures.some((dep) => dep.manager === 'github-actions' && dep.depType === 'service' &&
    dep.datasource === 'docker' && dep.packageName === 'mcr.microsoft.com/playwright'));
});

test('coordinated groups survive each shared profile and Actions-only consumption', async (t) => {
  for (const name of ['app-library', 'web-app', 'gitops', 'github-actions']) {
    await t.test(name, async () => {
      const config = await profile(name, {
        separateMajorMinor: true, separateMultipleMajor: true,
        separateMultipleMinor: true, separateMinorPatch: true,
      });
      const families = [
        ['Node.js', 'nodejs', (dep) => ['node', 'docker.io/library/node'].includes(dep.depName)],
        ['Bun', 'bun', (dep) => dep.depName === 'bun' || dep.depName === 'oven/bun'],
        ['Playwright', 'playwright', (dep) =>
          ['@playwright/test', 'playwright', 'playwright-core', '@playwright/browser-chromium',
            '@playwright/experimental-ct-svelte', 'mcr.microsoft.com/playwright'].includes(dep.depName)],
        ['SvelteKit', 'sveltekit', (dep) => dep.depName === '@sveltejs/kit' ||
          dep.depName.startsWith('@sveltejs/adapter-') ||
          dep.depName.startsWith('@sveltejs/vite-plugin-svelte') ||
          dep.depName === 'svelte' || dep.depName === 'vite'],
      ];
      for (const [groupName, slug, matches] of families) {
        const branches = new Set();
        for (const dep of fixtures.filter(matches)) {
          for (const updateType of ['major', 'minor', 'patch', 'digest']) {
            const result = await update(config, dep, updateType);
            assert.equal(result.groupName, groupName, name + ': ' + dep.manager + '/' + dep.depName);
            assert.equal(result.groupSlug, slug);
            for (const flag of ['separateMajorMinor', 'separateMultipleMajor',
              'separateMultipleMinor', 'separateMinorPatch']) {
              assert.equal(result[flag], false, name + ': ' + flag);
            }
            runtime.branchNames.generateBranchName(result);
            branches.add(result.branchName);
          }
        }
        assert.deepEqual([...branches], ['renovate/' + slug], name + ': coordinated branch identity');
      }
    });
  }
});

test('ordinary actions, unrelated packages and non-Svelte Vite updates stay outside the groups', async () => {
  const config = await profile('web-app');
  for (const name of ['actions/setup-node', 'oven-sh/setup-bun']) {
    const dep = fixtures.find((candidate) => candidate.depName === name);
    assert.equal((await update(config, dep)).groupName, 'github actions');
  }
  for (const name of ['redis', 'kindest/node', 'react', '@playwright/mcp', '@sveltejs/enhanced-img']) {
    const dep = fixtures.find((candidate) => candidate.depName === name);
    assert.notEqual((await update(config, dep)).groupName, 'Node.js');
    assert.notEqual((await update(config, dep)).groupName, 'Playwright');
    assert.notEqual((await update(config, dep)).groupName, 'SvelteKit');
  }
  const imagePlugin = fixtures.find((dep) => dep.depName === '@sveltejs/enhanced-img');
  const optionalMajor = await update(config, imagePlugin, 'major');
  assert.notEqual(optionalMajor.groupName, 'SvelteKit');
  assert.equal(optionalMajor.dependencyDashboardApproval, true);
  const vite = fixtures.find((dep) => dep.depName === 'vite');
  for (const repository of ['webdev-harke/portfolio', 'lkshrk/omni']) {
    assert.notEqual((await update(config, vite, 'major', repository)).groupName, 'SvelteKit');
  }
  for (const repository of ['webdev-harke/ISC', 'webdev-harke/pfalz-herz',
    'webdev-harke/pizzeria-riva', 'webdev-harke/quintessenz-horst']) {
    assert.equal((await update(config, vite, 'major', repository)).groupName, 'SvelteKit');
  }
});

test('real branch generation retains every member merge gate', async () => {
  const config = await profile('web-app');
  const deps = fixtures.filter((dep) => dep.depName === 'node' &&
    ['github-actions', 'dockerfile'].includes(dep.manager));
  const upgrades = [];
  for (const dep of deps) {
    const result = await update(config, dep, dep.manager === 'github-actions' ? 'major' : 'patch');
    runtime.branchNames.generateBranchName(result);
    upgrades.push(result);
  }
  assert.equal(upgrades.length, 2);
  // The workflow major forbids automerge; a member's approval requirement
  // must also survive when it joins the same branch as other update types.
  const requiringApproval = await update(config, deps.find((dep) => dep.manager === 'dockerfile'), 'major');
  runtime.branchNames.generateBranchName(requiringApproval);
  assert.equal(upgrades[0].branchName, requiringApproval.branchName);
  const branch = runtime.branches.generateBranchConfig([upgrades[0], requiringApproval]);
  assert.equal(branch.automerge, false);
  assert.equal(branch.dependencyDashboardApproval, true);
  assert.equal(branch.updateType, 'major');
});

test('root test harnesses are included without enabling fixture or vendored manifests', async (t) => {
  const files = [
    'package.json', 'tests/package.json', 'tests/bun.lock', 'tests/package-lock.json',
    'tests/fixtures/package.json', 'tests/e2e/fixtures/package.json', 'apps/example/tests/package.json',
    'node_modules/pkg/package.json', 'tests/node_modules/pkg/package.json',
    '__tests__/package.json', 'test/package.json', '__fixtures__/package.json', 'resources/package.json',
  ];
  for (const name of ['app-library', 'web-app', 'gitops']) {
    await t.test(name, async () => {
      const config = await profile(name);
      for (const managerName of ['npm', 'bun']) {
        const managerConfig = runtime.config.getManagerConfig(config, managerName);
        const matching = runtime.matching.getMatchingFiles({
          ...runtime.manager.getManagers().get(managerName).defaultConfig,
          ...managerConfig,
          manager: managerName,
        }, files);
        assert.ok(matching.includes('tests/package.json'));
        if (managerName === 'bun') assert.ok(matching.includes('tests/bun.lock'));
        assert.ok(!matching.some((file) => /fixtures|node_modules|__tests__|^test\/|apps\/example/.test(file)));
        if (name === 'gitops') assert.ok(!matching.includes('resources/package.json'));
      }
    });
  }
});

test('explicit manager allowlists remain explicit after group resolution', async () => {
  const enabledManagers = ['github-actions', 'custom.regex'];
  const config = await profile('github-actions', { enabledManagers });
  assert.deepEqual(config.enabledManagers, enabledManagers);
});
