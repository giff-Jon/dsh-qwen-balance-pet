/**
 * 无凭证预检：用假 AK 分别打两个接口，确认**请求格式被服务端接受**。
 *
 * 判据：返回 InvalidAccessKeyId（key 无效）而不是 MissingParameter / InvalidParameter / 404 no-route。
 * 前者说明签名与参数结构都对，只差真 key；后者说明我们的请求本身有问题。
 */
import { buildSignedUrl } from '../src/signature.js';

const ACTIONS = ['QueryCashCoupons', 'QueryAccountBalance'];
let ok = 0;

for (const action of ACTIONS) {
  const url = buildSignedUrl({
    endpoint: 'business.aliyuncs.com',
    action,
    version: '2017-12-14',
    accessKeyId: 'LTAI_dummy_for_preflight',
    accessKeySecret: 'dummy_secret_for_preflight',
  });
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const text = await res.text();
  let code = '';
  try {
    code = JSON.parse(text).Code || '';
  } catch {
    /* 非 JSON */
  }
  const acceptable = /InvalidAccessKeyId|SignatureDoesNotMatch/.test(code);
  console.log(
    `${acceptable ? 'OK  ' : 'FAIL'} ${action}: HTTP ${res.status} Code=${code || '(none)'}`,
  );
  if (!acceptable) console.log('      body:', text.slice(0, 300));
  if (acceptable) ok++;
}

console.log(ok === ACTIONS.length ? '\n两个接口的请求格式均被服务端接受' : '\n请求格式有问题');
process.exitCode = ok === ACTIONS.length ? 0 : 1;