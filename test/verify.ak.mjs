/**
 * 真实取数验证：用配置好的 AK 直接调两个接口，确认能拿到真数据。
 * 只打印**结果**与错误码，绝不打印密钥。
 */
import { resolveCredentials } from '../src/credentials.js';
import { queryAccountBalance, queryCashCoupons, summarizeCoupons } from '../src/bss.js';
import { maskAkId } from '../src/credentials.js';

const creds = resolveCredentials({ config: {} });
if (!creds) {
  console.log('FAIL 读不到 AK');
  process.exit(1);
}
console.log('凭证来源:', creds.source, '| 端点:', creds.endpoint, '| AK:', maskAkId(creds.akId));

const base = {
  endpoint: creds.endpoint,
  akId: creds.akId,
  akSecret: creds.akSecret,
  stsToken: creds.stsToken,
};

// 代金券
try {
  const coupons = await queryCashCoupons(base);
  const s = summarizeCoupons(coupons);
  console.log('\n✅ QueryCashCoupons 成功');
  console.log('   返回券总数:', coupons.length, '| 可用:', s.count, '| 解析失败:', s.skipped);
  console.log('   >>> 可用代金券合计: ¥' + s.total);
  for (const c of s.items) {
    console.log(`   · ¥${c.balance}  到期 ${c.expiryTime?.slice(0, 10) || '?'}  ${c.applicableProducts || ''}`);
  }
} catch (e) {
  console.log('\n❌ QueryCashCoupons 失败:', e.message);
}

// 账户余额
try {
  const a = await queryAccountBalance(base);
  console.log('\n✅ QueryAccountBalance 成功');
  console.log('   可用额度:', a.available, '| 现金:', a.cash, '| 信控:', a.credit, '|', a.currency);
} catch (e) {
  console.log('\n❌ QueryAccountBalance 失败:', e.message);
}