/**
 * 激活后验证：轮询 dsh-pet 的 /state，确认 balance 叶子从 unsupported 变成真余额。
 *
 * 用法：node test/verify.live.mjs [baseUrl]
 */
const base = process.argv[2] || 'http://127.0.0.1:59123';
const url = `${base}/dsh-pet-7340/state`;

const deadline = Date.now() + 60_000;
let last = '';

while (Date.now() < deadline) {
  try {
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    const body = await res.json();
    const bal = body?.sections?.balance?.data;
    const line = JSON.stringify(bal);
    if (line !== last) {
      console.log(new Date().toLocaleTimeString(), line);
      last = line;
    }
    if (bal && bal.ok === true) {
      console.log('\n✅ 余额已显示');
      console.log(JSON.stringify(bal, null, 2));
      process.exit(0);
    }
    if (bal && bal.reason === 'fetch-error') {
      console.log('\n⚠️  provider 已注册，但取数失败（看 message）');
      console.log(JSON.stringify(bal, null, 2));
      process.exit(2);
    }
  } catch (e) {
    console.log(new Date().toLocaleTimeString(), 'state 读取失败:', e.message);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('\n超时：60s 内未看到成功余额。最后状态:', last);
process.exit(1);