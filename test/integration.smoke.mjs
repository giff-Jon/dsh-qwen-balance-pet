/**
 * 集成冒烟：用一个假的 Cordis ctx 模拟宿主，验证插件真的能把 provider 注册进去，
 * 并且注册后的 fetch 能产出 dsh-pet 能认的 money 结构。
 *
 * 这一步不改任何真实配置、不打网络 —— 只是把 src/index.js 的接线逻辑跑一遍。
 */
import assert from 'node:assert/strict';

const SRC = new URL('../src/index.js', import.meta.url).href;

// ---- 假 ctx：模拟 dsh-pet 提供的软服务 petApi7340 ----
const registry = new Map();
const effects = [];
let disposed = false;

const ctx = {
  get(name, required) {
    if (name === 'petApi7340') {
      return {
        balance: {
          register(def) {
            if (registry.has(def.id)) throw new Error('该服务商 id 已被注册: ' + def.id);
            registry.set(def.id, def);
            return () => registry.delete(def.id);
          },
          list: () => ({ builtin: [], external: [...registry.keys()] }),
        },
      };
    }
    if (required) throw new Error('missing service: ' + name);
    return undefined;
  },
  effect(fn) {
    effects.push(fn());
  },
  logger: {
    info: (m) => console.log('  [info]', m),
    warn: (m) => console.log('  [warn]', m),
  },
};

const mod = await import(SRC);

// ---- 1) apply 后必须完成注册（多个 id） ----
mod.apply(ctx, { aliyun: { akId: 'a', akSecret: 'b' } });
assert.ok(registry.has('qwen-token-plan-cn'), 'apply 后必须注册 qwen-token-plan-cn');
console.log('OK: provider 已注册 →', [...registry.keys()].join(', '));
assert.ok(registry.size > 1, '应注册多个常见 provider 名，避免别人名字不同就失效');

// ---- 2) 注册的 fetch 必须产出 dsh-pet 认的 money 结构 ----
const def = registry.get('qwen-token-plan-cn');
assert.equal(def.id, 'qwen-token-plan-cn');
assert.equal(typeof def.fetch, 'function');

const result = await def.fetch({ provider: 'qwen-token-plan-cn' });
assert.equal(result.ok, true);
assert.equal(result.shape, 'money');
assert.equal(result.provider, 'qwen-token-plan-cn');
assert.ok(Array.isArray(result.data.wallets) && result.data.wallets.length === 1);
const w = result.data.wallets[0];
// dsh-pet 的 parse.ts 只认这几个字段
for (const k of ['currency', 'total', 'granted', 'toppedUp']) {
  assert.equal(typeof w[k], 'string', `wallet.${k} 必须是字符串`);
  assert.ok(w[k].length > 0, `wallet.${k} 不能为空`);
}
console.log('OK: fetch 返回合法 money 结构 →', JSON.stringify(w));

// ---- 3) 卸载时必须注销 ----
for (const d of effects) if (typeof d === 'function') d();
assert.equal(registry.size, 0, '卸载后必须注销全部 provider');
console.log('OK: 卸载后 provider 已全部注销');