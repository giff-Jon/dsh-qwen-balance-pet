/**
 * 凭证解析：按优先级找出阿里云 AccessKey。
 *
 * 优先级（先命中的赢）：
 *   1. 环境变量 —— ALIYUN_AK_ID/ALIYUN_AK_SECRET（以及官方 SDK 常用的别名）
 *   2. AK 文件 —— 默认 %USERPROFILE%\.dsh\qwen-coupon.json
 *   3. 插件配置里的明文 akId/akSecret（**最不安全**，仅作兜底）
 *
 * 安全约定：
 *   - Secret / STS Token **绝不**出现在日志、错误消息或返回给浏览器的 payload 里；
 *   - 对外只给掩码后的 AccessKeyId（maskAkId）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 环境变量别名：官方 SDK 用 ALIBABA_CLOUD_*，生态里 ALIYUN_* 也常见。 */
const ID_ENVS = ['ALIYUN_AK_ID', 'ALIYUN_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_ID'];
const SECRET_ENVS = ['ALIYUN_AK_SECRET', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'];
const TOKEN_ENVS = ['ALIYUN_STS_TOKEN', 'ALIBABA_CLOUD_SECURITY_TOKEN'];
const ENDPOINT_ENVS = ['ALIYUN_BSS_ENDPOINT'];

/** 默认 AK 文件位置（与 dsh-qwen-balance 的约定保持一致，便于两插件共用一份）。 */
export function defaultAkFile() {
  return join(homedir(), '.dsh', 'qwen-coupon.json');
}

/**
 * 剥掉 UTF-8 BOM（若存在）。
 *
 * 为什么必须做：Windows 记事本默认存成「UTF-8 with BOM」，PowerShell 的
 * `Set-Content -Encoding UTF8` 同样会写 EF BB BF。Node 的 `JSON.parse` 不接受开头的
 * BOM，会抛 `Unexpected token '﻿'` —— 用户眼里文件明明是对的，插件却报"未配置 AccessKey"。
 * 这类问题极难自查，所以在这里兜住。
 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 掩码 AccessKeyId（可以出现在响应里，Secret 不行）。
 * 与 dsh-qwen-balance 同口径：≤12 位取前 2 位 + `***`；更长取前 6 + `...` + 后 4。
 */
export function maskAkId(id) {
  if (typeof id !== 'string' || id.length === 0) return '';
  if (id.length <= 12) return id.slice(0, 2) + '***';
  return id.slice(0, 6) + '...' + id.slice(-4);
}

/** 从进程环境读一对 AK；凑不齐返回 null。 */
function fromEnv(env) {
  const id = ID_ENVS.map((k) => env[k]).find((v) => typeof v === 'string' && v.length > 0);
  const secret = SECRET_ENVS.map((k) => env[k]).find((v) => typeof v === 'string' && v.length > 0);
  if (!id || !secret) return null;
  const token = TOKEN_ENVS.map((k) => env[k]).find((v) => typeof v === 'string' && v.length > 0);
  const endpoint = ENDPOINT_ENVS.map((k) => env[k]).find((v) => typeof v === 'string' && v.length > 0);
  return { source: 'env', akId: id, akSecret: secret, stsToken: token, endpoint };
}

/**
 * 从 AK 文件读。文件不存在 / 不是 JSON / 缺字段 → 返回 null（**不抛**，
 * 因为"没配 AK"是正常的初始状态，不是错误）。
 */
function fromFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    // 必须剥掉 UTF-8 BOM：Windows 记事本、PowerShell 的 `Set-Content -Encoding UTF8`
    // 都会在开头写 EF BB BF，而 JSON.parse 遇到它直接抛 "Unexpected token"。
    // 不处理的话，用户填好的文件会看起来完全正常、插件却一直报"未配置 AccessKey"（踩过）。
    parsed = JSON.parse(stripBom(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const id = typeof parsed.aliyunAkId === 'string' ? parsed.aliyunAkId.trim() : '';
  const secret = typeof parsed.aliyunAkSecret === 'string' ? parsed.aliyunAkSecret.trim() : '';
  if (!id || !secret) return null;
  const token = typeof parsed.aliyunStsToken === 'string' && parsed.aliyunStsToken ? parsed.aliyunStsToken : undefined;
  const endpoint =
    typeof parsed.bssEndpoint === 'string' && parsed.bssEndpoint ? parsed.bssEndpoint.trim() : undefined;
  return { source: 'file', akId: id, akSecret: secret, stsToken: token, endpoint };
}

/** 从插件配置读明文（兜底）。 */
function fromConfig(cfg) {
  const id = typeof cfg?.akId === 'string' ? cfg.akId.trim() : '';
  const secret = typeof cfg?.akSecret === 'string' ? cfg.akSecret.trim() : '';
  if (!id || !secret) return null;
  return { source: 'config', akId: id, akSecret: secret, stsToken: undefined, endpoint: cfg?.endpoint };
}

/**
 * 解析出一对可用的 AccessKey。
 *
 * @param {object} [o]
 * @param {object} [o.config] 插件配置（aliyun 段）
 * @param {NodeJS.ProcessEnv} [o.env] 进程环境（测试可注入）
 * @returns {{source:string, akId:string, akSecret:string, stsToken?:string, endpoint?:string} | null}
 */
export function resolveCredentials({ config = {}, env = process.env } = {}) {
  const useFile = config.useAkFile !== false;
  const filePath = typeof config.akFile === 'string' && config.akFile ? config.akFile : defaultAkFile();

  const found =
    fromEnv(env) ??
    (useFile ? fromFile(filePath) : null) ??
    fromConfig(config);
  if (!found) return null;

  // 端点：配置里的 aliyun.endpoint 优先于环境变量 / 文件里的，因为它是最显式的用户意图
  const configured = typeof config.endpoint === 'string' && config.endpoint ? config.endpoint.trim() : '';
  return { ...found, endpoint: configured || found.endpoint || DEFAULTS.endpoint };
}

/** 默认值。国内站 BSS 端点是 business.aliyuncs.com；国际站是 business.ap-southeast-1.aliyuncs.com。 */
export const DEFAULTS = {
  endpoint: 'business.aliyuncs.com',
  /** BSS OpenAPI 版本号（固定） */
  apiVersion: '2017-12-14',
};