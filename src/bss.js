/**
 * 阿里云 BSS OpenAPI 客户端：只做两件事 —— 查代金券、查账户余额。
 *
 * 两个接口都是 RPC 风格（GET + 查询串 + 签名 V1.0）：
 *   - QueryCashCoupons    代金券（权限点 bss:DescribeCoupons）
 *   - QueryAccountBalance 账户可用额度/现金（权限点 bss:DescribeAcccount）
 *
 * 设计口径（与 dsh-pet 的 provider 契约一致）：
 *   - **只负责成功路径**，任何失败一律 throw，由调用方统一落成 fetch-error；
 *   - 绝不伪造数字：拿不到券就是拿不到，不返回 0。
 */
import { buildSignedUrl } from './signature.js';
import { DEFAULTS } from './credentials.js';

/** 单次请求超时（阿里云 BSS 偶尔慢，给 15s）。 */
const TIMEOUT_MS = 15_000;
/** 瞬时失败（网络/5xx）的重试次数，与 dsh-pet 内置 provider 的口径一致。 */
const RETRIES = 2;

/**
 * 判据：这个错误值不值得重试。鉴权/权限/参数类错误重试多少次都一样，不浪费时间和配额。
 *
 * 注意不能用「`失败：` 后面跟字母」这种宽松正则来识别业务错误 —— `ECONNRESET`、`ETIMEDOUT`
 * 这些**瞬时网络错误**恰好也是字母开头，会被误判成确定性错误而放弃重试（踩过）。
 * 这里改为**白名单匹配阿里云真实返回的错误码**（PascalCase，形如 InvalidAccessKeyId.NotFound）。
 */
function isRetryable(message) {
  // 阿里云业务错误码：以大写字母开头的 CamelCase（可能带 . 后缀）
  const businessCode = /失败：([A-Z][A-Za-z]*(?:\.[A-Za-z]+)*)\s*—/;
  return !businessCode.test(message);
}

/** 导出供测试直接验证判据（避免只能通过重试次数间接观察）。 */
export { isRetryable };

/**
 * 发一个已签名的 BSS 请求并解析 JSON（含瞬时失败重试）。
 *
 * @param {object} o
 * @param {string} o.endpoint
 * @param {string} o.action
 * @param {string} o.akId
 * @param {string} o.akSecret
 * @param {string} [o.stsToken]
 * @param {object} [o.bizParams]
 * @param {typeof fetch} [o.fetchImpl] 注入 fetch（测试用）
 * @returns {Promise<any>} 已确认 `Success === true` 的响应体
 * @throws {Error} 网络失败 / 超时 / 非 2xx / Success=false —— 消息里**不含**密钥
 */
export async function callBss(o) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await callBssOnce(o);
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === RETRIES || !isRetryable(msg)) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw last;
}

/** 一次尝试（不含重试）。 */
async function callBssOnce({ endpoint, action, akId, akSecret, stsToken, bizParams = {}, fetchImpl = fetch }) {
  const url = buildSignedUrl({
    endpoint,
    action,
    version: DEFAULTS.apiVersion,
    accessKeyId: akId,
    accessKeySecret: akSecret,
    securityToken: stsToken,
    bizParams,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    // 关键：错误消息里**绝不**带 url（它含 Signature，且 nonce 等参数会进日志）
    const why = e?.name === 'AbortError' ? `请求超时（${TIMEOUT_MS / 1000}s）` : e?.message || String(e);
    throw new Error(`阿里云 ${action} 请求失败：${why}`);
  } finally {
    clearTimeout(timer);
  }

  // 先读 body 再判状态码：阿里云在**非 2xx**（实测鉴权失败回 HTTP 404，不是 400）时
  // 依然给一个规范的 JSON 错误体，里面有 Code 与 Message。若先判 res.ok 就抛 "HTTP 404"，
  // 用户只会看到一句无用的状态码，而丢掉 "Specified access key is not found." 这种关键诊断。
  let body;
  try {
    body = await res.json();
  } catch {
    // 连 JSON 都不是（网关 5xx 的 HTML、断流等）→ 只能退回状态码
    if (!res.ok) throw new Error(`阿里云 ${action} HTTP ${res.status}`);
    throw new Error(`阿里云 ${action} 响应不是合法 JSON`);
  }

  // 成功路径的唯一判据是 Success === true（HTTP 状态码不可靠）
  if (body?.Success !== true) {
    const code = body?.Code || `HTTP ${res.status}`;
    const msg = body?.Message || '未知错误';
    throw new Error(`阿里云 ${action} 失败：${code} — ${msg}`);
  }
  return body;
}

/**
 * 查代金券。
 *
 * 注意：`QueryCashCoupons` **没有**按券号过滤的参数，一次返回该账号的全部券；
 * 我们只把 `Status === 'Available'` 的 `Balance` 计入合计（过期/已作废的券不算钱）。
 *
 * @returns {Promise<Array<object>>} 券列表（已归一化字段名）
 */
export async function queryCashCoupons(opts) {
  const body = await callBss({ ...opts, action: 'QueryCashCoupons' });
  const list = body?.Data?.CashCoupon;
  // 没有任何券时阿里云给的可能是 undefined / 空数组 —— 两者都算"没有券"，不是错误
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('阿里云 QueryCashCoupons 响应 Data.CashCoupon 不是数组');
  return list.map(normalizeCoupon);
}

/** 归一化一张券：字段名统一成 camelCase，金额保持字符串原样（不重算、不换算）。 */
function normalizeCoupon(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    id: r.CashCouponId !== undefined && r.CashCouponId !== null ? String(r.CashCouponId) : '',
    no: typeof r.CashCouponNo === 'string' ? r.CashCouponNo : '',
    status: typeof r.Status === 'string' ? r.Status : '',
    /** 余额（字符串，接口原样） */
    balance: typeof r.Balance === 'string' ? r.Balance : '',
    /** 面额（字符串，接口原样） */
    nominalValue: typeof r.NominalValue === 'string' ? r.NominalValue : '',
    expiryTime: typeof r.ExpiryTime === 'string' ? r.ExpiryTime : '',
    effectiveTime: typeof r.EffectiveTime === 'string' ? r.EffectiveTime : '',
    applicableProducts: typeof r.ApplicableProducts === 'string' ? r.ApplicableProducts : '',
    applicableScenarios: typeof r.ApplicableScenarios === 'string' ? r.ApplicableScenarios : '',
    description: typeof r.Description === 'string' ? r.Description : '',
  };
}

/**
 * 查账户余额（可用额度/现金/信控）。
 *
 * 官方明确：**可用额度不包含代金券与储值卡**，所以它是与券互相独立的数字。
 */
export async function queryAccountBalance(opts) {
  const body = await callBss({ ...opts, action: 'QueryAccountBalance' });
  const d = body?.Data;
  if (!d || typeof d !== 'object') throw new Error('阿里云 QueryAccountBalance 响应缺少 Data');
  const pick = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  return {
    available: pick(d.AvailableAmount),
    cash: pick(d.AvailableCashAmount),
    credit: pick(d.CreditAmount),
    currency: typeof d.Currency === 'string' ? d.Currency : '',
  };
}

/**
 * 把一批券折算成"可用合计"。
 *
 * 用整数分累加再转回字符串，避免浮点误差把 263.66 变成 263.65999999999997。
 *
 * @param {Array<{status:string,balance:string}>} coupons
 * @returns {{total:string,count:number,items:Array<object>}} 只统计 Available 的券
 */
export function summarizeCoupons(coupons) {
  const available = coupons.filter((c) => c.status === 'Available');
  let cents = 0n;
  let bad = 0;
  for (const c of available) {
    const parsed = toCents(c.balance);
    if (parsed === null) {
      bad++;
      continue;
    }
    cents += parsed;
  }
  return {
    total: fromCents(cents),
    count: available.length - bad,
    /** 余额字段解析失败的张数（不静默吞掉，交给调用方决定要不要提示） */
    skipped: bad,
    items: available,
  };
}

/** "100.00" → 10000n（分）。非法返回 null。 */
function toCents(v) {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,}))?$/.exec(v.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = BigInt(m[2]);
  const frac = (m[3] || '').padEnd(2, '0').slice(0, 2);
  return sign * (whole * 100n + BigInt(frac));
}

/** 10000n → "100.00" */
function fromCents(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const s = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}