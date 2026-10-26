/**
 * dsh-qwen-balance-pet —— 宿主半侧（Cordis 插件入口）。
 *
 * 作用：把 `qwen-token-plan-cn` 这个 provider id 注册进 dsh-pet 的余额注册表，
 * 让蓝毛小女仆的气泡显示阿里云代金券余额。
 *
 * 接线方式（dsh-pet 公开的扩展点）：
 *   ctx.get('petApi7340').balance.register({ id, fetch })
 *
 * 时序要点：dsh-pet 与本草稿都在同一个 profile 的 bundle 层栈里，谁先 apply 不保证。
 * 所以这里**轮询等待** petApi7340 出现，而不是假设它已经在场。拿到后立刻注册，
 * 并在插件卸载时注销（ctx.effect 负责收尾）。
 */

/** 本插件的行 id（与 cordis.patch.yml 一致）。 */
export const name = 'qwen-balance-pet';

/**
 * 依赖的服务：只需要 cordis 本身与 petApi7340 这个**软服务**。
 * petApi7340 不进 inject —— 它由 dsh-pet 提供，若 dsh-pet 没装或版本太老（<0.3.8），
 * 硬 inject 会让本插件永远停在 pending。这里改用轮询 + 超时放弃，行为可预期。
 */
export const inject = [];

/**
 * 要接管的 provider id 列表（= profile 里 agent-default-model 配的 provider）。
 *
 * 为什么是**多个**而不是一个：provider id 是各人自己在 llm-pi-ai 里起的名字，
 * 没有统一标准。有人叫 `qwen-token-plan-cn`，有人叫 `bailian`、`dashscope`、`qwen`……
 * 只写一个的话，别人装了插件也会因为名字对不上而静默失效（显示"暂不支持余额查询"）。
 * 这里把常见命名都注册上；id 命中谁，谁就生效。
 *
 * 可用配置 `providerIds` 覆盖（数组或逗号分隔字符串），例如：
 *   { "providerIds": ["my-qwen-provider"] }
 */
const DEFAULT_PROVIDER_IDS = [
  'qwen-token-plan-cn',
  'qwen-token-plan',
  'qwen',
  'qwen-cn',
  'dashscope',
  'bailian',
  'aliyun-bailian',
  'model-studio',
];

/** 把配置里的 providerIds 规整成非空字符串数组。 */
function normalizeIds(configured) {
  if (configured === undefined || configured === null || configured === '') return DEFAULT_PROVIDER_IDS;
  const list = Array.isArray(configured)
    ? configured
    : String(configured)
        .split(',')
        .map((s) => s.trim());
  const cleaned = list.filter((s) => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim());
  return cleaned.length > 0 ? cleaned : DEFAULT_PROVIDER_IDS;
}

/** 等待 petApi7340 出现的最长时间与轮询间隔（毫秒）。 */
const WAIT_TIMEOUT_MS = 60_000;
const WAIT_INTERVAL_MS = 500;

export function apply(ctx, config = {}) {
  // 延迟 import：本文件在 host 侧同步加载，provider 逻辑按需拉起
  let disposed = false;
  const unregisters = new Map();
  let waiter = null;
  const providerIds = normalizeIds(config.providerIds);

  const tryRegister = () => {
    if (disposed) return true;
    const api = ctx.get?.('petApi7340', false);
    const register = api?.balance?.register;
    if (typeof register !== 'function') return false;

    for (const id of providerIds) {
      if (unregisters.has(id)) continue;
      try {
        const off = register({
          id,
          async fetch({ provider }) {
            // 动态 import：避免在 petApi7340 还没影时就把整个 provider 链拉进内存
            const { fetchQwenBalance } = await import('./provider.js');
            return fetchQwenBalance({ provider, config: config.aliyun ?? config });
          },
        });
        unregisters.set(id, off);
      } catch (e) {
        // 单个 id 冲突（例如被别的插件占了）不影响其余 id
        ctx.logger?.warn?.(`[qwen-balance-pet] 注册 provider "${id}" 失败：${e?.message || e}`);
      }
    }
    const ok = [...unregisters.keys()];
    if (ok.length > 0) {
      ctx.logger?.info?.(
        `[qwen-balance-pet] 已注册余额 provider：${ok.join(', ')} —— 宠物气泡将显示阿里云代金券余额`,
      );
      return true;
    }
    return false;
  };

  // 先立刻试一次（常见情况下 dsh-pet 已经先 apply 完了）
  if (!tryRegister()) {
    const startedAt = Date.now();
    waiter = setInterval(() => {
      if (tryRegister() || Date.now() - startedAt > WAIT_TIMEOUT_MS) {
        if (unregisters.size === 0 && !disposed) {
          ctx.logger?.warn?.(
            `[qwen-balance-pet] 等待 petApi7340 超时（${WAIT_TIMEOUT_MS / 1000}s）：` +
              '请确认已安装 dsh-pet >= 0.3.8（第三方余额 provider 是 0.3.8 引入的）',
          );
        }
        clearInterval(waiter);
        waiter = null;
      }
    }, WAIT_INTERVAL_MS);
    // 定时器不该拖住进程退出
    waiter.unref?.();
  }

  // 卸载时注销全部 provider 与定时器
  ctx.effect(() => () => {
    disposed = true;
    if (waiter) {
      clearInterval(waiter);
      waiter = null;
    }
    for (const off of unregisters.values()) {
      try {
        off();
      } catch {
        // 注销失败不影响卸载
      }
    }
    unregisters.clear();
  }, 'qwen-balance-pet: 注销余额 provider');
}