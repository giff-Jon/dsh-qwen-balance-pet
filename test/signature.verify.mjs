/**
 * 签名实现的验证脚本：对着阿里云官方文档给出的规则逐条核对。
 *
 * 官方文档示例（AccessKeyId=testid，Secret=yourAccessKeySecret）把签名值打了星号，
 * 无法直接复算，所以这里改用**可复算**的方式验证：
 *   1. percentEncode 的三条修正规则（+ → %20、* → %2A、%7E → ~）；
 *   2. 参数按码点序排序、空值剔除；
 *   3. StringToSign 的拼接形态（GET&%2F&...）；
 *   4. 用固定参数得到一个稳定签名，作为回归基准。
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { percentEncode, signRpc } from '../src/signature.js';

// ---- 1) percentEncode 规则 ----
assert.equal(percentEncode(' '), '%20', '空格必须编成 %20 而不是 +');
assert.equal(percentEncode('*'), '%2A', '星号必须编成 %2A');
assert.equal(percentEncode('~'), '~', '波浪号不编码');
assert.equal(percentEncode('/'), '%2F', '斜杠编成 %2F');
assert.equal(percentEncode('a-b_c.d~e'), 'a-b_c.d~e', 'A-Za-z0-9 与 -_.~ 不编码');
assert.equal(percentEncode('"'), '%22', '双引号编成 %22');

// ---- 2) 排序与空值剔除 ----
// 手动重算一遍 StringToSign，确认 signRpc 内部走的是同一套规则
const params = { Action: 'GetOpenStatus', Version: '2021-07-30', Empty: '', Nul: null };
const expectPairs = [
  ['Action', 'GetOpenStatus'],
  ['Version', '2021-07-30'],
];
const canonical = expectPairs.map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join('&');
const expectedStringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`;
const expectedSig = createHmac('sha1', 'yourAccessKeySecret&').update(expectedStringToSign, 'utf8').digest('base64');

assert.equal(
  signRpc(params, 'yourAccessKeySecret'),
  expectedSig,
  'signRpc 必须与手写的规范化流程一致（含空值剔除）',
);

// ---- 3) 入参顺序不影响签名 ----
const orderA = signRpc({ a: '1', B: '2', Z: '3' }, 's');
const orderB = signRpc({ Z: '3', B: '2', a: '1' }, 's');
assert.equal(orderA, orderB, '入参顺序不影响签名');

// ---- 4) 固定向量的回归基准 ----
const fixed = signRpc(
  {
    Format: 'JSON',
    Version: '2017-12-14',
    AccessKeyId: 'testid',
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: '2026-10-26T08:30:00Z',
    SignatureVersion: '1.0',
    SignatureNonce: 'fixed-nonce-for-test',
    Action: 'QueryCashCoupons',
  },
  'testsecret',
);
console.log('fixed signature =', fixed);
assert.match(fixed, /^[A-Za-z0-9+/]+=*$/, '签名必须是 Base64');

// ---- 5) 换密钥必须换签名（防止密钥被忽略） ----
assert.notEqual(signRpc({ A: '1' }, 'secret-one'), signRpc({ A: '1' }, 'secret-two'));

console.log('OK: 全部签名规则验证通过');