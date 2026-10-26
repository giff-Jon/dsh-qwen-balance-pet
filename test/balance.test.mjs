/**
 * 单元测试：签名 / 取数 / 券折算 / 凭证解析 / 错误路径。
 * 全部离线 —— fetch 一律注入假实现，绝不真的打阿里云。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { percentEncode, signRpc } from '../src/signature.js';
import { callBss, isRetryable, queryAccountBalance, queryCashCoupons, summarizeCoupons } from '../src/bss.js';
import { maskAkId, resolveCredentials, stripBom } from '../src/credentials.js';
import { couponDetail, fetchQwenBalance } from '../src/provider.js';

/** 造一个假的 fetch：记录调用、返回给定 JSON。 */
function fakeFetch(payload, { ok = true, status = 200, throws = null } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw throws;
    return {
      ok,
      status,
      async json() {
        if (payload instanceof Error) throw payload;
        return payload;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

/** 从签名 URL 里取回某个参数值。 */
function paramOf(url, key) {
  const q = url.slice(url.indexOf('?') + 1);
  for (const pair of q.split('&')) {
    const [k, v] = pair.split('=');
    if (decodeURIComponent(k) === key) return decodeURIComponent(v.replace(/\+/g, '%20'));
  }
  return undefined;
}

/**
 * 按 Action 分派的假 fetch。
 *
 * 不能用「第几次调用」来区分两个接口：provider 用 Promise.allSettled **并发**发券与账户两个请求，
 * 谁先到不确定。这里直接从签名 URL 里读 Action，行为与真实并发一致。
 */
function byAction(map) {
  const calls = [];
  const impl = async (url) => {
    const action = paramOf(url, 'Action');
    calls.push({ url, action });
    const payload = map[action];
    if (payload === undefined) throw new Error('unexpected action: ' + action);
    return {
      ok: true,
      status: 200,
      async json() {
        return payload;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

// ---------------- 签名 ----------------

test('percentEncode 遵循阿里云三条修正规则', () => {
  assert.equal(percentEncode(' '), '%20');
  assert.equal(percentEncode('*'), '%2A');
  assert.equal(percentEncode('~'), '~');
  assert.equal(percentEncode('/'), '%2F');
  assert.equal(percentEncode('aA0-_.~'), 'aA0-_.~');
});

test('signRpc 剔除空值且与入参顺序无关', () => {
  const a = signRpc({ B: '2', a: '1', Empty: '', N: null, U: undefined }, 'sec');
  const b = signRpc({ a: '1', B: '2' }, 'sec');
  assert.equal(a, b);
});

test('签名结果稳定（固定参数 → 固定 Base64）', () => {
  const sig = signRpc(
    { Action: 'QueryCashCoupons', Format: 'JSON', SignatureNonce: 'n1', Timestamp: '2026-10-26T08:30:00Z' },
    'testsecret',
  );
  assert.match(sig, /^[A-Za-z0-9+/]+=*$/);
  // 同一组输入必须永远得到同一个签名
  assert.equal(
    sig,
    signRpc(
      { Timestamp: '2026-10-26T08:30:00Z', SignatureNonce: 'n1', Format: 'JSON', Action: 'QueryCashCoupons' },
      'testsecret',
    ),
  );
});

test('签名 URL 含全部公共参数，且 Secret 不出现在 URL 里', () => {
  const impl = fakeFetch({ Success: true, Data: { CashCoupon: [] } });
  return callBss({
    endpoint: 'business.aliyuncs.com',
    action: 'QueryCashCoupons',
    akId: 'LTAI_test_id',
    akSecret: 'SUPER_SECRET_VALUE',
    fetchImpl: impl,
  }).then(() => {
    const url = impl.calls[0].url;
    assert.equal(paramOf(url, 'Action'), 'QueryCashCoupons');
    assert.equal(paramOf(url, 'Version'), '2017-12-14');
    assert.equal(paramOf(url, 'SignatureMethod'), 'HMAC-SHA1');
    assert.equal(paramOf(url, 'SignatureVersion'), '1.0');
    assert.equal(paramOf(url, 'AccessKeyId'), 'LTAI_test_id');
    assert.ok(paramOf(url, 'Signature'), '必须带签名');
    assert.match(paramOf(url, 'Timestamp'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(!url.includes('SUPER_SECRET_VALUE'), 'AccessKey Secret 绝不能进 URL');
  });
});

// ---------------- BSS 调用与错误路径 ----------------

test('Success=false 即使 HTTP 200 也必须抛错，且消息含错误码', async () => {
  const impl = fakeFetch({ Success: false, Code: 'NotAuthorized', Message: 'no perm' });
  await assert.rejects(
    () =>
      callBss({
        endpoint: 'e',
        action: 'QueryCashCoupons',
        akId: 'a',
        akSecret: 'b',
        fetchImpl: impl,
      }),
    /NotAuthorized/,
  );
});

test('非 2xx 抛错', async () => {
  const impl = fakeFetch({}, { ok: false, status: 500 });
  await assert.rejects(
    () => callBss({ endpoint: 'e', action: 'X', akId: 'a', akSecret: 'b', fetchImpl: impl }),
    /HTTP 500/,
  );
});

test('回归：Aliyun 用 404 回鉴权失败时，必须带出 body 里的 Code/Message 而不是只有状态码', async () => {
  // 实测行为：AccessKeyId 不存在时 business.aliyuncs.com 回 HTTP 404 +
  // {"Code":"InvalidAccessKeyId.NotFound","Message":"Specified access key is not found."}
  const impl = fakeFetch(
    {
      RequestId: 'x',
      Code: 'InvalidAccessKeyId.NotFound',
      Message: 'Specified access key is not found.',
    },
    { ok: false, status: 404 },
  );
  await assert.rejects(
    () => callBss({ endpoint: 'e', action: 'QueryCashCoupons', akId: 'a', akSecret: 'b', fetchImpl: impl }),
    (e) => {
      assert.match(e.message, /InvalidAccessKeyId\.NotFound/, '必须带错误码');
      assert.match(e.message, /Specified access key is not found/, '必须带可读原因');
      return true;
    },
  );
});

test('非 2xx 且响应不是 JSON 时，退回状态码提示', async () => {
  const impl = fakeFetch(new Error('html'), { ok: false, status: 502 });
  await assert.rejects(
    () => callBss({ endpoint: 'e', action: 'X', akId: 'a', akSecret: 'b', fetchImpl: impl }),
    /HTTP 502/,
  );
});

test('瞬时网络失败会重试，最终成功', async () => {
  let n = 0;
  const impl = async () => {
    n++;
    if (n < 3) throw new Error('ECONNRESET');
    return { ok: true, status: 200, async json() { return { Success: true, Data: {} }; } };
  };
  const body = await callBss({ endpoint: 'e', action: 'X', akId: 'a', akSecret: 'b', fetchImpl: impl });
  assert.equal(body.Success, true);
  assert.equal(n, 3, '前两次失败后第三次应成功');
});

test('鉴权类错误不重试（重试多少次都一样，别浪费配额）', async () => {
  let n = 0;
  const impl = async () => {
    n++;
    return {
      ok: false,
      status: 404,
      async json() {
        return { Code: 'InvalidAccessKeyId.NotFound', Message: 'not found' };
      },
    };
  };
  await assert.rejects(
    () => callBss({ endpoint: 'e', action: 'X', akId: 'a', akSecret: 'b', fetchImpl: impl }),
    /InvalidAccessKeyId/,
  );
  assert.equal(n, 1, '确定性错误只应请求一次');
});

test('回归：ECONNRESET/ETIMEDOUT 这类字母开头的网络错误必须可重试', () => {
  // 曾经的实现用 /失败：[A-Za-z]/ 识别业务错误，把 ECONNRESET 误判成确定性错误而不重试
  assert.equal(isRetryable('阿里云 X 请求失败：ECONNRESET'), true);
  assert.equal(isRetryable('阿里云 X 请求失败：ETIMEDOUT'), true);
  assert.equal(isRetryable('阿里云 X 请求失败：fetch failed'), true);
  assert.equal(isRetryable('阿里云 X 请求超时（15s）'), true);
  assert.equal(isRetryable('阿里云 X HTTP 502'), true);
  // 真实业务错误码不可重试
  assert.equal(isRetryable('阿里云 X 失败：InvalidAccessKeyId.NotFound — nope'), false);
  assert.equal(isRetryable('阿里云 X 失败：NotAuthorized — nope'), false);
  assert.equal(isRetryable('阿里云 X 失败：NotApplicable — nope'), false);
});

test('响应不是 JSON 时抛错（不把 HTML 当数据）', async () => {
  const impl = fakeFetch(new Error('bad json'));
  await assert.rejects(
    () => callBss({ endpoint: 'e', action: 'X', akId: 'a', akSecret: 'b', fetchImpl: impl }),
    /不是合法 JSON/,
  );
});

test('超时（AbortError）被转成可读的中文提示', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const impl = fakeFetch({}, { throws: abort });
  await assert.rejects(
    () => callBss({ endpoint: 'e', action: 'X', akId: 'a', akSecret: 'b', fetchImpl: impl }),
    /请求超时/,
  );
});

// ---------------- 券解析与折算 ----------------

const COUPON_BODY = {
  Success: true,
  Data: {
    CashCoupon: [
      {
        Status: 'Available',
        Balance: '100.00',
        NominalValue: '300.00',
        ExpiryTime: '2027-10-20T00:00:00Z',
        CashCouponId: 923898490070,
        CashCouponNo: 'Q-abc',
        ApplicableProducts: '通用',
      },
      { Status: 'Expired', Balance: '50.00', ExpiryTime: '2020-01-01T00:00:00Z' },
      { Status: 'Available', Balance: '163.66', ExpiryTime: '2028-01-01T00:00:00Z' },
    ],
  },
};

test('只把 Available 的券计入合计，过期券不算钱', async () => {
  const coupons = await queryCashCoupons({
    endpoint: 'e',
    akId: 'a',
    akSecret: 'b',
    fetchImpl: fakeFetch(COUPON_BODY),
  });
  assert.equal(coupons.length, 3);
  const s = summarizeCoupons(coupons);
  assert.equal(s.total, '263.66', '100.00 + 163.66，过期那张不计');
  assert.equal(s.count, 2);
  assert.equal(s.skipped, 0);
});

test('金额用整数分累加，避免浮点误差', () => {
  const s = summarizeCoupons([
    { status: 'Available', balance: '0.10' },
    { status: 'Available', balance: '0.20' },
  ]);
  assert.equal(s.total, '0.30', '0.1+0.2 不能变成 0.30000000000000004');
});

test('券列表缺失（undefined）算"没有券"而不是错误', async () => {
  const coupons = await queryCashCoupons({
    endpoint: 'e',
    akId: 'a',
    akSecret: 'b',
    fetchImpl: fakeFetch({ Success: true, Data: {} }),
  });
  assert.deepEqual(coupons, []);
});

test('CashCoupon 不是数组 → 抛错（响应形态变了要显式失败）', async () => {
  await assert.rejects(
    () =>
      queryCashCoupons({
        endpoint: 'e',
        akId: 'a',
        akSecret: 'b',
        fetchImpl: fakeFetch({ Success: true, Data: { CashCoupon: { oops: 1 } } }),
      }),
    /不是数组/,
  );
});

test('余额字段非法的那张被跳过并计数，不污染合计', () => {
  const s = summarizeCoupons([
    { status: 'Available', balance: '10.00' },
    { status: 'Available', balance: 'not-a-number' },
  ]);
  assert.equal(s.total, '10.00');
  assert.equal(s.skipped, 1);
  assert.equal(s.count, 1);
});

test('账户余额解析（可用/现金/信控）', async () => {
  const a = await queryAccountBalance({
    endpoint: 'e',
    akId: 'a',
    akSecret: 'b',
    fetchImpl: fakeFetch({
      Success: true,
      Data: { AvailableAmount: '0.01', AvailableCashAmount: '0.01', CreditAmount: '0.00', Currency: 'CNY' },
    }),
  });
  assert.deepEqual(a, { available: '0.01', cash: '0.01', credit: '0.00', currency: 'CNY' });
});

// ---------------- 凭证 ----------------

test('maskAkId 掩码规则：短 id 前2+***，长 id 前6+...+后4', () => {
  assert.equal(maskAkId(''), '');
  assert.equal(maskAkId('LTAI12345678'), 'LT***');
  assert.equal(maskAkId('LTAI5tABCDEFGH1234'), 'LTAI5t...1234');
});

test('凭证优先级：环境变量 > 文件 > 配置', () => {
  const env = { ALIYUN_AK_ID: 'env_id', ALIYUN_AK_SECRET: 'env_sec' };
  // useAkFile:false —— 真实 AK 文件排在 env 与 config 之间，不关掉会污染这两条断言
  const c = resolveCredentials({ config: { akId: 'cfg_id', akSecret: 'cfg_sec', useAkFile: false }, env });
  assert.equal(c.source, 'env');
  assert.equal(c.akId, 'env_id');
});

test('环境变量缺一半时回落到配置，不会用半对凭证', () => {
  const env = { ALIYUN_AK_ID: 'only_id' };
  const c = resolveCredentials({ config: { akId: 'cfg_id', akSecret: 'cfg_sec', useAkFile: false }, env });
  assert.equal(c.source, 'config');
  assert.equal(c.akId, 'cfg_id');
});

test('完全没有凭证 → null', () => {
  // 必须显式关掉 AK 文件：默认路径指向用户的真实文件，一旦用户配好了 AK，
  // 这条"没有任何凭证"的断言就会被真实文件打破（踩过）。
  assert.equal(resolveCredentials({ config: { useAkFile: false }, env: {} }), null);
});

test('默认端点是国内站 business.aliyuncs.com', () => {
  const c = resolveCredentials({ config: { akId: 'a', akSecret: 'b', useAkFile: false }, env: {} });
  assert.equal(c.endpoint, 'business.aliyuncs.com');
});

test('回归：AK 文件带 UTF-8 BOM 时仍能解析（记事本/PowerShell 的默认行为）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-ak-'));
  try {
    const p = join(dir, 'qwen-coupon.json');
    // 模拟记事本保存：JSON 前面加 BOM
    writeFileSync(p, '\uFEFF' + JSON.stringify({ aliyunAkId: 'LTAI_bom', aliyunAkSecret: 'sec_bom' }), 'utf8');
    const c = resolveCredentials({ config: { akFile: p }, env: {} });
    assert.ok(c, '带 BOM 的文件必须能被读到，否则用户会看到"未配置 AccessKey"');
    assert.equal(c.akId, 'LTAI_bom');
    assert.equal(c.source, 'file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stripBom 只剥开头那一个 BOM', () => {
  assert.equal(stripBom('\uFEFF{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
  assert.equal(stripBom(''), '');
});

test('回归：AK 文件字段首尾有空白时也能用（复制粘贴常见的多余空格）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-ak-'));
  try {
    const p = join(dir, 'qwen-coupon.json');
    writeFileSync(p, JSON.stringify({ aliyunAkId: '  LTAI_spaced  ', aliyunAkSecret: '  sec  ' }), 'utf8');
    const c = resolveCredentials({ config: { akFile: p }, env: {} });
    assert.equal(c.akId, 'LTAI_spaced', 'ID 必须 trim，否则签名会失败');
    assert.equal(c.akSecret, 'sec');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('国际站端点可经配置覆盖', () => {
  const c = resolveCredentials({
    config: { akId: 'a', akSecret: 'b', endpoint: 'business.ap-southeast-1.aliyuncs.com' },
    env: {},
  });
  assert.equal(c.endpoint, 'business.ap-southeast-1.aliyuncs.com');
});

// ---------------- provider 组装 ----------------

test('provider：券 + 账户都成功时，只出一条券钱包', async () => {
  const impl = byAction({
    QueryCashCoupons: COUPON_BODY,
    QueryAccountBalance: { Success: true, Data: { AvailableAmount: '0.01', Currency: 'CNY' } },
  });
  const r = await fetchQwenBalance({
    provider: 'qwen-token-plan-cn',
    config: { akId: 'a', akSecret: 'b' },
    env: {},
    fetchImpl: impl,
  });
  assert.equal(r.ok, true);
  assert.equal(r.shape, 'money');
  assert.equal(r.provider, 'qwen-token-plan-cn');
  assert.equal(r.data.wallets.length, 1, '同币种不该出两条（否则气泡变成 ¥a/¥b）');
  assert.equal(r.data.wallets[0].total, '263.66');
  assert.equal(r.data.wallets[0].currency, 'CNY');
  assert.equal(r.data.wallets[0].toppedUp, '0.00');
});

test('provider：没有 AK 时抛出的消息要指导用户去配置', async () => {
  await assert.rejects(
    // useAkFile:false 关掉真实文件，否则用户配好 AK 后这条断言会失效
    () => fetchQwenBalance({ provider: 'p', config: { useAkFile: false }, env: {}, fetchImpl: fakeFetch({}) }),
    /未配置阿里云 AccessKey/,
  );
});

test('provider：券接口失败但账户成功 → 用账户可用额度顶上', async () => {
  const impl = byAction({
    QueryCashCoupons: { Success: false, Code: 'NotAuthorized', Message: 'no coupon perm' },
    QueryAccountBalance: { Success: true, Data: { AvailableAmount: '12.34', Currency: 'CNY' } },
  });
  const r = await fetchQwenBalance({
    provider: 'p',
    config: { akId: 'a', akSecret: 'b' },
    env: {},
    fetchImpl: impl,
  });
  assert.equal(r.data.wallets[0].total, '12.34');
});

test('provider：两个接口都失败 → 抛错（绝不伪造 0）', async () => {
  const impl = fakeFetch({ Success: false, Code: 'NotAuthorized', Message: 'nope' });
  await assert.rejects(
    () => fetchQwenBalance({ provider: 'p', config: { akId: 'a', akSecret: 'b' }, env: {}, fetchImpl: impl }),
    /NotAuthorized/,
  );
});

test('provider：没有可用券也没有可用额度 → 抛错而不是显示 ¥0.00', async () => {
  const impl = byAction({
    QueryCashCoupons: { Success: true, Data: { CashCoupon: [{ Status: 'Expired', Balance: '99.00' }] } },
    QueryAccountBalance: { Success: true, Data: { AvailableAmount: '0', Currency: 'CNY' } },
  });
  await assert.rejects(
    () => fetchQwenBalance({ provider: 'p', config: { akId: 'a', akSecret: 'b' }, env: {}, fetchImpl: impl }),
    /没有可用的代金券/,
  );
});

test('回归：账户可用额度恰为 "0" 时不得当成余额显示（非空字符串恒真的坑）', async () => {
  const impl = byAction({
    QueryCashCoupons: { Success: true, Data: { CashCoupon: [] } },
    QueryAccountBalance: { Success: true, Data: { AvailableAmount: '0', Currency: 'CNY' } },
  });
  await assert.rejects(
    () => fetchQwenBalance({ provider: 'p', config: { akId: 'a', akSecret: 'b' }, env: {}, fetchImpl: impl }),
    /没有可用的代金券/,
    '可用额度 0 不是余额，必须走"没有可用券也没有可用额度"的错误分支',
  );
});

test('回归：可用券余额为 0（未过期）时仍算"有券"，不退化成账户额度', async () => {
  const impl = byAction({
    QueryCashCoupons: {
      Success: true,
      Data: { CashCoupon: [{ Status: 'Available', Balance: '0.00', ExpiryTime: '2027-01-01T00:00:00Z' }] },
    },
    QueryAccountBalance: { Success: true, Data: { AvailableAmount: '999.00', Currency: 'CNY' } },
  });
  const r = await fetchQwenBalance({
    provider: 'p',
    config: { akId: 'a', akSecret: 'b' },
    env: {},
    fetchImpl: impl,
  });
  assert.equal(r.data.wallets.length, 1);
  assert.equal(r.data.wallets[0].total, '0.00', '仍是券那条钱包，不该被 999 的账户额度顶掉');
});

test('couponDetail 摘要含张数与到期日，且最多列 3 张', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    status: 'Available',
    balance: '10.00',
    expiryTime: '2027-10-20T00:00:00Z',
  }));
  const d = couponDetail(many);
  assert.match(d, /代金券 5 张/);
  assert.match(d, /2027-10-20 到期/);
  assert.match(d, /等 5 张/);
});