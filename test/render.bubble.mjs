/**
 * 用 dsh-pet **自己编译好的**生产代码算气泡文案。
 *
 * 障碍与绕法：
 *  1. Node 拒绝对 node_modules 下的 .ts 做类型剥离 → 把源码拷到临时目录；
 *  2. 源码用「目录导入」（from './handlers'），ESM 不认 → 拷贝时把目录导入补成 /index.ts。
 * 这样验证的是 dsh-pet 的真实渲染逻辑，而不是我手写的近似。
 *
 * dsh-pet 的位置按以下顺序解析（可用 PET_DIR 环境变量覆盖）：
 *   $PET_DIR > $DSH_HOME/profiles/desktop/node_modules/dsh-pet > 脚本内默认
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DSH_PET_CANDIDATES = [
  process.env.PET_DIR,
  process.env.DSH_HOME && join(process.env.DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-pet'),
  join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-pet'),
].filter(Boolean);

const PET = DSH_PET_CANDIDATES.find((p) => existsSync(join(p, 'src', 'shared', 'balance')));
if (!PET) {
  console.error('找不到 dsh-pet，请设置 PET_DIR 环境变量指向 dsh-pet 包目录。');
  console.error('已尝试:', DSH_PET_CANDIDATES.join('\n         '));
  process.exit(1);
}

const STATE_URL = process.env.PET_STATE_URL || 'http://127.0.0.1:59123/dsh-pet-7340/state';

const res = await fetch(STATE_URL);
const state = (await res.json()).sections.balance.data;
console.log('叶子数据:', JSON.stringify(state));

const dir = mkdtempSync(join(tmpdir(), 'pet-render-'));
const root = join(dir, 'balance');
try {
  cpSync(join(PET, 'src/shared/balance'), root, { recursive: true });

  // 把所有目录导入补成 /index.ts，并去掉类型专用的 import（import type 混在普通 import 里时）-
  const walk = (d) =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  for (const f of walk(root)) {
    if (!f.endsWith('.ts')) continue;
    let src = readFileSync(f, 'utf8');
    src = src.replace(/from '(\.[^']*)'/g, (m, spec) => {
      const abs = join(f, '..', spec);
      try {
        if (statSync(abs).isDirectory()) return `from '${spec}/index.ts'`;
      } catch {
        /* 不存在就当普通文件 */
      }
      if (/\.ts$/.test(spec)) return m;
      try {
        if (statSync(abs + '.ts').isFile()) return `from '${spec}.ts'`;
      } catch {
        /* ignore */
      }
      return m;
    });
    writeFileSync(f, src);
  }

  const { toBalanceState } = await import(pathToFileURL(join(root, 'parse.ts')).href);
  const { balanceBubbleView, balanceDetailView } = await import(pathToFileURL(join(root, 'view.ts')).href);

  const view = toBalanceState(state);
  console.log('\n解析后的 view:', JSON.stringify(view));

  const rows = balanceBubbleView(view);
  console.log('\n气泡（收起态）行:');
  for (const r of rows) console.log('  ', JSON.stringify(r));
  console.log('\n>>> 气泡文案:', rows.map((r) => r.text).join(''));

  const detail = balanceDetailView(view);
  console.log('>>> 展开态文案:', detail.map((r) => r.text).join(''));
} finally {
  rmSync(dir, { recursive: true, force: true });
}