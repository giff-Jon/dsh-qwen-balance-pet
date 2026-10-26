/**
 * 一键安装到 DSH profile。
 *
 * 做三件事：
 *   1. 把本包拷进目标 profile 的 node_modules；
 *   2. 在 profile 的 package.json 里登记 dependency 与 bundle 层；
 *   3. 预检解析是否成立（跑 preflight.profile.mjs）。
 *
 * 不碰 AK、不重启服务 —— 装完提示用户自己重启。
 *
 * 用法：
 *   node install.mjs                    # 装进 desktop profile
 *   node install.mjs --profile web      # 装进指定 profile
 *   node install.mjs --dry-run          # 只打印将要做什么
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_NAME = 'dsh-qwen-balance-pet';
const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const pIdx = argv.indexOf('--profile');
const PROFILE_NAME = pIdx !== -1 ? argv[pIdx + 1] : process.env.DSH_PROFILE || 'desktop';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE_DIR =
  process.env.DSH_PROFILE_DIR || join(DSH_HOME, 'profiles', PROFILE_NAME);

if (!existsSync(join(PROFILE_DIR, 'package.json'))) {
  console.error(`✗ 找不到 profile: ${PROFILE_DIR}`);
  console.error('  先建一个（例如）：dsh <profile> --from-default-profile web --dump-config');
  process.exit(1);
}

const dest = join(PROFILE_DIR, 'node_modules', PKG_NAME);
console.log(`profile : ${PROFILE_DIR}`);
console.log(`安装到  : ${dest}`);

// 1) 拷贝包内容（排除 node_modules/.git/test）
const SKIP = new Set(['node_modules', '.git', 'test']);
if (!dryRun) {
  mkdirSync(dest, { recursive: true });
  cpSync(HERE, dest, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(HERE.length).replace(/^[\\/]/, '');
      const top = rel.split(/[\\/]/)[0];
      return top === '' || !SKIP.has(top);
    },
  });
}
console.log('✓ 已拷贝包文件');

// 2) 登记 dependency + bundle 层
const manifestPath = join(PROFILE_DIR, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.dependencies ??= {};
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];

if (!manifest.dependencies[PKG_NAME]) {
  // 用 file: 指向已拷贝的位置，避免 pnpm 下次 install 把它当外部依赖去 registry 找
  manifest.dependencies[PKG_NAME] = `file:./node_modules/${PKG_NAME}`;
  console.log('✓ 已登记 dependency');
} else {
  console.log('· dependency 已存在，跳过');
}

if (!manifest.dsh.profile.bundles.includes(PKG_NAME)) {
  manifest.dsh.profile.bundles.push(PKG_NAME);
  console.log('✓ 已加入 bundles 层');
} else {
  console.log('· bundles 已包含，跳过');
}

if (!dryRun) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// 3) 预检
if (!dryRun) {
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync(process.execPath, [join(HERE, 'test', 'preflight.profile.mjs')], {
      stdio: 'inherit',
      env: { ...process.env, DSH_PROFILE_DIR: PROFILE_DIR },
    });
  } catch {
    console.error('✗ 预检失败，请检查上面的输出');
    process.exit(1);
  }
}

console.log(`
完成。接下来：
  1. 配置阿里云 AccessKey（否则气泡只会提示未配置）：
     写 ~/.dsh/qwen-coupon.json，或用环境变量 ALIYUN_AK_ID / ALIYUN_AK_SECRET
  2. 重启 DSH（宿主半才会加载新插件），然后刷新页面
  3. 敲 /balance 或右键宠物「查看余额」验证
`);