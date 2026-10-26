/**
 * 阿里云 BSS OpenAPI 的 RPC 风格签名（Signature Version 1.0，HMAC-SHA1）。
 *
 * 为什么手写而不用官方 SDK：本插件只调两个只读接口，为一个签名算法拖进
 * @alicloud/* 一整棵依赖树不划算，而且宿主插件是 ESM 直接跑的，依赖越干净越好。
 *
 * 签名算法（阿里云 RPC 风格，V1.0）：
 *   1. 公共参数 + 业务参数合并，剔除空值；
 *   2. 按参数名做**字典序**升序排序（注意是码点序，不是本地化序）；
 *   3. 逐个拼成 `k=v`，用 `&` 连接 → 得到规范化查询串（CanonicalizedQueryString）；
 *   4. StringToSign = `GET&%2F&` + percentEncode(规范化查询串)；
 *   5. Signature = Base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign))；
 *   6. 把 Signature 作为参数追加进请求。
 *
 * percentEncode 的坑（签名与 URL 两处必须用同一套）：
 *   - 先做标准 encodeURIComponent；
 *   - 再把 `+` → `%20`、`*` → `%2A`、`%7E` → `~` 换回来；
 *   - 阿里云要求空格编成 `%20`（不是 `+`），`~` 不编码。
 */
import { createHmac } from 'node:crypto';

/** 阿里云特有的百分号编码：在 encodeURIComponent 基础上修正三个字符。 */
export function percentEncode(value) {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/**
 * 用 Signature Version 1.0 给一组参数签名。
 *
 * @param {object} params 公共参数 + 业务参数（值会先 String() 化；null/undefined/'' 一律剔除）
 * @param {string} accessKeySecret AccessKey Secret（**永不**写进返回结果或日志）
 * @param {'GET'|'POST'} [method] HTTP 方法，默认 GET
 * @returns {string} Base64 编码的签名
 */
export function signRpc(params, accessKeySecret, method = 'GET') {
  // 1) 剔除空值 + 全部字符串化
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)]);

  // 2) 按参数名码点序升序
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  // 3) 规范化查询串（**已编码**）
  const canonical = pairs.map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join('&');

  // 4) StringToSign —— 路径固定 `/`（RPC 风格只有一个根路径）
  const stringToSign = `${method.toUpperCase()}&${percentEncode('/')}&${percentEncode(canonical)}`;

  // 5) HMAC-SHA1，密钥是 "AccessKeySecret&"（尾部 & 是规范的一部分，不能省）
  return createHmac('sha1', `${accessKeySecret}&`).update(stringToSign, 'utf8').digest('base64');
}

/**
 * 组装一个已签名的 BSS OpenAPI 请求 URL。
 *
 * @param {object} o
 * @param {string} o.endpoint 主机名（如 business.aliyuncs.com）
 * @param {string} o.action 接口名（如 QueryCashCoupons）
 * @param {string} o.version API 版本（BSS 固定 2017-12-14）
 * @param {string} o.accessKeyId
 * @param {string} o.accessKeySecret
 * @param {object} [o.bizParams] 业务参数
 * @param {string} [o.securityToken] STS Token（可选）
 * @param {Date} [o.now] 注入时钟，便于测试固定签名向量
 * @returns {string} 完整 URL
 */
export function buildSignedUrl({
  endpoint,
  action,
  version = '2017-12-14',
  accessKeyId,
  accessKeySecret,
  bizParams = {},
  securityToken,
  now = new Date(),
}) {
  // 阿里云要求 ISO8601 **UTC**，形如 2026-10-26T08:30:00Z
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

  /** @type {Record<string, string>} */
  const params = {
    // ---- 公共参数 ----
    Format: 'JSON',
    Version: version,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: timestamp,
    SignatureVersion: '1.0',
    SignatureNonce: cryptoRandomNonce(),
    Action: action,
    ...(securityToken ? { SecurityToken: securityToken } : {}),
    // ---- 业务参数 ----
    ...bizParams,
  };

  params.Signature = signRpc(params, accessKeySecret);
  const query = Object.entries(params)
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(String(v))}`)
    .join('&');
  return `https://${endpoint}/?${query}`;
}

/**
 * 随机串（SignatureNonce）：阿里云要求每次请求唯一，防重放。
 * 用 Web Crypto 的 UUID 即可，不比 Math.random 更贵，且避免无依赖。
 */
function cryptoRandomNonce() {
  return globalThis.crypto.randomUUID();
}