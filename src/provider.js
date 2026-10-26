/**
 * dsh-pet 第三方余额 provider：`qwen-token-plan-cn`（阿里云百炼 Token Plan）。
 *
 * 为什么需要它：百炼/DashScope 的 `sk-` key **没有任何余额接口**，代金券只能走
 * 阿里云 BSS OpenAPI（需要一对带只读权限的 AccessKey）。dsh-pet 内置的 4 条路由
 * 都不认 `qwen-token-plan-cn`，所以先前余额一直显示 "unsupported"。
 *
 * 展示形态选用 `money`（账户金额）—— 宠物气泡渲染成「余额 ¥x.xx」，
 * 与 DeepSeek 路由同一套气泡。`wallets` 里放两条同币种钱包：
 *   1. 代金券可用合计（用户最关心的数字，放第一位）
 *   2. 账户可用额度（官方明确**不含**代金券，所以是独立的一条）
 *
 * 注意：第三方 provider 的 fetch **只拿得到 `{ provider }`** —— dsh-pet 宿主不会
 * 帮我们解析凭证，也不会给 resolveAccount。所以 AK/SK 由本插件自己解决。
 */
import { queryAccountBalance, queryCashCoupons, summarizeCoupons } from './bss.js';
import { resolveCredentials } from './credentials.js';

/** 人民币。BSS 只回 CNY 账户的这两个数字（Currency 字段也可能给别的，这里以券为准）。 */
const CURRENCY = 'CNY';

/** 金额字符串是否表示"真的大于 0"（`'0'` / `'0.00'` / 负数 / 非数字 → false）。 */
function isPositiveAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

/**
 * 取数：并发查券与账户余额，合成 dsh-pet 的 money 形态。
 *
 * 失败策略：**两个接口都失败才抛**。只有一个失败时仍返回能拿到的那部分
 * （例如 AK 没有 bss:DescribeAcccount 权限，但券能查到 —— 用户要的是券）。
 *
 * @param {object} o
 * @param {string} o.provider provider id（原样回填）
 * @param {object} [o.config] 插件配置（aliyun 段 + pollIntervalSec）
 * @returns {Promise<object>} dsh-pet 的 BalanceSuccess
 */
export async function fetchQwenBalance({ provider, config = {}, env = process.env, fetchImpl = fetch }) {
  const creds = resolveCredentials({ config, env });
  if (!creds) {
    // 没有 AK 是"还没配"，不是崩溃 —— 但按契约必须 throw，由宿主落成 fetch-error，
    // 消息要能指导用户去配 AK（这是他们唯一会看到的提示）
    throw new Error(
      '未配置阿里云 AccessKey：请设置 ALIYUN_AK_ID / ALIYUN_AK_SECRET，' +
        '或写入 ~/.dsh/qwen-coupon.json（需 bss:DescribeCoupons 与 bss:DescribeAcccount 权限）',
    );
  }

  const base = {
    endpoint: creds.endpoint,
    akId: creds.akId,
    akSecret: creds.akSecret,
    stsToken: creds.stsToken,
    fetchImpl,
  };

  // 两个接口没有依赖关系，并发发；各自收敛成败，不互相牵连
  const [couponsRes, accountRes] = await Promise.allSettled([
    queryCashCoupons(base),
    queryAccountBalance(base),
  ]);

  // 两个都失败 → 抛第一个错误（通常是权限或 AK 问题，最有诊断价值）
  if (couponsRes.status === 'rejected' && accountRes.status === 'rejected') {
    throw couponsRes.reason instanceof Error ? couponsRes.reason : new Error(String(couponsRes.reason));
  }

  const wallets = [];

  if (couponsRes.status === 'fulfilled') {
    const summary = summarizeCoupons(couponsRes.value);
    // **只在一张可用券都没有时**才算"没有券"：余额为 0 但尚未过期的券是真实的券
    // （可能刚好用完了），它仍然是"有券"这个事实，不该退化成账户额度或报错。
    if (summary.count > 0) {
      wallets.push({
        currency: CURRENCY,
        // 券就是"平台赠送"，所以 granted=total、toppedUp=0 —— 语义准确
        total: summary.total,
        granted: summary.total,
        toppedUp: '0.00',
      });
    }
  }

  // 账户可用额度**不单独占一个钱包**：dsh-pet 的 money 气泡只按币种拼「¥a/¥b」，
  // 同币种两条会渲染成「余额 ¥263.66/¥0.01」，读起来像两个余额，反而糊。
  // 券才是用户要的 C 位数字，所以：券取不到时才用账户可用额度顶上（有总比没有好）。
  if (wallets.length === 0 && accountRes.status === 'fulfilled') {
    const a = accountRes.value;
    // 必须是**真的大于 0** 才顶上来：`'0'`/`'0.00'` 是"没有额度"的意思，
    // 直接判 `a.available` 会因为非空字符串恒真而把 0 当余额显示出来（曾经的 bug）。
    if (a.available && isPositiveAmount(a.available)) {
      wallets.push({
        currency: a.currency || CURRENCY,
        total: a.available,
        granted: '0.00',
        toppedUp: a.available,
      });
    }
  }

  // 一张可用券都没有、账户额度也为 0 → 不做成 "¥0.00" 假象，
  // 而是明确抛错，让用户看到"没有可用的代金券"而不是"余额为零"
  if (wallets.length === 0) throw new Error('阿里云账户当前没有可用的代金券，也没有可用额度');

  return {
    ok: true,
    provider,
    shape: 'money',
    data: { wallets },
  };
}

/**
 * 券明细（给需要的调用方/排障用，不参与气泡渲染 —— dsh-pet 的 money 形态只吃
 * currency/total/granted/toppedUp/fullBalance，多写的字段会在 parse 阶段被丢掉）。
 */
export function couponDetail(coupons) {
  const available = coupons.filter((c) => c.status === 'Available');
  if (available.length === 0) return '';
  const parts = available.slice(0, 3).map((c) => {
    const exp = c.expiryTime ? `（${c.expiryTime.slice(0, 10)} 到期）` : '';
    return `¥${c.balance}${exp}`;
  });
  const more = available.length > 3 ? ` 等 ${available.length} 张` : '';
  return `代金券 ${available.length} 张：${parts.join('、')}${more}`;
}