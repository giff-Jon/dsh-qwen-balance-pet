/**
 * 用与 DSH 完全相同的解析逻辑预检：dsh.profile.bundles 里的每个名字，
 * 都要能从 profile 目录解析出包，且该包必须声明 dsh.bundle.patch 且文件存在。
 *
 * 这一步在重启 dsh web **之前**跑，避免"改坏了配置 → 起不来"。
 *
 * profile 目录解析顺序：$DSH_PROFILE_DIR > $DSH_HOME/profiles/<PROFILE_NAME> > ~/.dsh/profiles/<PROFILE_NAME>
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE_NAME = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR =
  process.env.DSH_PROFILE_DIR ||
  (process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'profiles', PROFILE_NAME)
    : join(homedir(), '.dsh', 'profiles', PROFILE_NAME));

if (!existsSync(join(PROFILE_DIR, 'package.json'))) {
  console.error('找不到 profile:', PROFILE_DIR);
  process.exit(1);
}
console.log('profile:', PROFILE_DIR);

const manifest = JSON.parse(readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8'));
const bundles = manifest.dsh?.profile?.bundles ?? [];
console.log('bundles:', bundles);

const require = createRequire(join(PROFILE_DIR, 'package.json'));

let failed = 0;
for (const packageName of bundles) {
  try {
    // 与 packageDirFromAnchor 等价的解析：从 profile/package.json 锚点找包目录
    const pkgJson = require.resolve(`${packageName}/package.json`);
    const packageDir = join(pkgJson, '..');
    const declared = JSON.parse(readFileSync(pkgJson, 'utf8')).dsh?.bundle?.patch;
    if (declared === undefined) {
      console.log(`  FAIL ${packageName}: 未声明 dsh.bundle`);
      failed++;
      continue;
    }
    const patchPath = join(packageDir, declared);
    if (!existsSync(patchPath)) {
      console.log(`  FAIL ${packageName}: patch 文件不存在 ${patchPath}`);
      failed++;
      continue;
    }
    console.log(`  OK   ${packageName} → ${patchPath}`);
  } catch (e) {
    console.log(`  FAIL ${packageName}: 解析失败 ${e.message}`);
    failed++;
  }
}

// 额外检查我们这一层：宿主入口必须存在且能被 import
try {
  const entry = require.resolve('dsh-qwen-balance-pet');
  console.log('\n宿主入口:', entry);
} catch (e) {
  console.log('\nFAIL 无法解析宿主入口:', e.message);
  failed++;
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;