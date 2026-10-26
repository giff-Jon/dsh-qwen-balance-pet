# dsh-qwen-balance-pet

让 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的桌宠气泡显示**阿里云代金券余额**。

装上之后，蓝毛小女仆的气泡会显示：

> 余额 ¥270.23

## 为什么需要它

两件事凑在一起，导致 dsh-pet 默认看不到百炼的代金券：

1. **dsh-pet 的余额按 provider id 取数**，内置只登记了 4 条路由
   （`opencode-go` / `commandcode` / `deepseek-official` / `deepseek-account`）。
   你在 `agent-default-model` 里配的千问/百炼 provider 不在表里 → 状态是
   `{"ok":false,"reason":"unsupported"}`，气泡什么数字都不显示。
2. **百炼 / DashScope 的 `sk-` API key 没有任何余额接口**（官方未提供）。
   想看代金券余额，只能走阿里云 **BSS OpenAPI**，需要一对
   `LTAI...` 形式的 AccessKey（AK/SK）——**不是** `sk-` key。

本插件把这两件事接起来：读 BSS → 注册成 dsh-pet 的余额 provider → 气泡显示。

## 安装

### 方式一：一键脚本（本仓库）

```bash
git clone <本仓库地址>
cd dsh-qwen-balance-pet
node install.mjs              # 装进 desktop profile
node install.mjs --profile web   # 或指定 profile
node install.mjs --dry-run       # 只看看会做什么
```

脚本会：拷包进 profile 的 `node_modules` → 在 profile 的 `package.json` 登记
dependency 与 bundle 层 → 跑一次解析预检。

> ⚠️ **前提**：目标 profile 必须已经装了 **dsh-pet ≥ 0.3.8**
> （第三方余额 provider 的注册接口是 0.3.8 引入的）。
> 另外 `desktop` profile 由 DSH 桌面应用独占管理，CLI 会拒绝直接改它；
> 用命令行装请选择你自己建的 profile。

装完**重启 DSH**（宿主半才会加载），再刷新页面。

### 方式二：手动

1. 把本包整个目录拷到 `<profile>/node_modules/dsh-qwen-balance-pet`
2. 在该 profile 的 `package.json` 里：
   - `dependencies` 加 `"dsh-qwen-balance-pet": "file:./node_modules/dsh-qwen-balance-pet"`
   - `dsh.profile.bundles` 数组里加 `"dsh-qwen-balance-pet"`
3. 重启 DSH

## 配置 AccessKey

**这是唯一必须的一步** —— 没有它气泡只会提示「未配置阿里云 AccessKey」。

按优先级解析，先命中的赢：

### 1. 环境变量（推荐服务器/长期使用）

```bash
ALIYUN_AK_ID=LTAI5t...
ALIYUN_AK_SECRET=...
```

也认官方 SDK 别名：`ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`。
临时凭据可另给 `ALIYUN_STS_TOKEN`。

### 2. AK 文件（推荐桌面使用）

`~/.dsh/qwen-coupon.json`（即 `%USERPROFILE%\.dsh\qwen-coupon.json`）：

```json
{
  "aliyunAkId": "LTAI5t...",
  "aliyunAkSecret": "...",
  "aliyunStsToken": "",
  "bssEndpoint": ""
}
```

> 文件带 UTF-8 BOM 也能读（记事本、PowerShell 默认会写 BOM，已做兼容）。

### 3. 插件配置里的明文（最不安全，仅兜底）

```json
{ "aliyun": { "akId": "LTAI5t...", "akSecret": "..." } }
```

## 怎么拿到 AccessKey

1. 登录[阿里云控制台](https://home.console.aliyun.com/) → 右上角头像 → **访问控制 RAM**
   （或直接开 [ram.console.aliyun.com](https://ram.console.aliyun.com/)）
2. **身份管理 → 用户 → 创建用户**，勾选 **使用永久 AccessKey 访问**
   （不用勾控制台访问）
3. 创建后弹窗里的 **AccessKey ID**（`LTAI` 开头）和 **AccessKey Secret** —— 当场复制，
   Secret 只显示这一次
4. 给这个用户挂托管策略 **`AliyunBSSReadOnlyAccess`**

### 需要的权限（最小可用）

| 调用 | 权限点 |
|---|---|
| `QueryCashCoupons`（代金券余额） | `bss:DescribeCoupons` |
| `QueryAccountBalance`（账户可用额度） | `bss:DescribeAcccount` |

`AliyunBSSReadOnlyAccess` 正好覆盖这两个，**不要**给 AdministratorAccess。

若返回 `NotApplicable`，说明该账号类型不能以 RAM 身份调 BSS，需改用主账号 AccessKey
（这是少数确实该用主账号的场合）。

### 国际站

账号在阿里云国际站时，把端点设为 `business.ap-southeast-1.aliyuncs.com`
（用 `ALIYUN_BSS_ENDPOINT` 环境变量、AK 文件的 `bssEndpoint`，或插件配置的 `aliyun.endpoint`）。
拿国内站端点去调国际站账号通常会超时。

## provider id 对不上怎么办

插件默认注册这些常见名字，命中哪个哪个生效：

```
qwen-token-plan-cn, qwen-token-plan, qwen, qwen-cn,
dashscope, bailian, aliyun-bailian, model-studio
```

你的 provider 叫别的名字（在 `llm-pi-ai` 配置里自己起的），加一行配置即可：

```json
{ "providerIds": ["我的自定义名字"] }
```

想知道当前 provider 到底叫什么，看 dsh-pet 的 `/state`：

```bash
curl http://127.0.0.1:<端口>/dsh-pet-7340/state
# sections.balance.data.provider 就是当前 provider id
```

## 组成

| 文件 | 作用 |
|---|---|
| `src/signature.js` | 阿里云 RPC 风格签名（Signature V1.0，HMAC-SHA1） |
| `src/credentials.js` | AccessKey 解析（环境变量 > AK 文件 > 配置）+ 脱敏 |
| `src/bss.js` | `QueryCashCoupons` / `QueryAccountBalance` 调用与解析 |
| `src/provider.js` | 组装成 dsh-pet 的 `money` 形态 |
| `src/index.js` | Cordis 插件入口：注册到 `petApi7340` |
| `cordis.patch.yml` | bundle 挂载声明 |

## 显示效果

气泡渲染成 `余额 ¥270.23`。只显示**一条钱包**（代金券可用合计）——
dsh-pet 的 money 气泡按币种拼 `¥a/¥b`，同币种出两条会读成"两个余额"，反而糊。
券取不到时才退而用账户可用额度顶上。

## 已验证

- `node --test "test/*.test.mjs"` —— 36 项，全离线
- 真实取数（2026-10-26）：`QueryCashCoupons` 返回 1 张可用券，合计 **¥270.68**
  （随使用实时递减，实测同会话内 270.68 → 270.42 → 270.23 → 269.35），到期 2027-10-23
- 气泡文案由 dsh-pet **自身**的渲染逻辑算出：`余额 ¥270.23`

## 踩过的坑（回归测试已覆盖）

| 坑 | 现象 | 处理 |
|---|---|---|
| `AvailableAmount: '0'` 非空字符串恒真 | 0 额度被当成余额显示 `¥0.00` | 改判数值 > 0 |
| 阿里云鉴权失败回 **HTTP 404** 而非 400 | 先判 `res.ok` 会吞掉 `InvalidAccessKeyId.NotFound` 的真实原因 | 先读 body 再判码 |
| `/失败：[A-Za-z]/` 误判网络错误 | `ECONNRESET` 也是字母开头 → 放弃重试，重试功能失效 | 改匹配 PascalCase 错误码 |
| **AK 文件带 UTF-8 BOM** | 记事本/PowerShell 存的文件看似正常，`JSON.parse` 报错 → 一直提示"未配置 AccessKey" | 读前 `stripBom` |
| provider id 硬编码 | 别人的 provider 叫别的名字 → 装了也静默失效 | 默认注册 8 个常见名 + `providerIds` 配置覆盖 |
| 测试隐式读真实 AK 文件 | 用户配好 AK 后，几条断言被真实文件打破 | 相关用例加 `useAkFile:false` |

## 测试与排障

```bash
node --test "test/*.test.mjs"    # 36 项，全离线（不打网络）
node test/preflight.profile.mjs  # 预检 bundle 解析是否成立
node test/verify.ak.mjs          # 用你配好的 AK 真打一次接口，确认能取到数
node test/preflight.api.mjs      # 用假 AK 确认请求格式被服务端接受
```

`verify.ak.mjs` 只打印余额与错误码，**不会打印密钥**（AccessKey ID 也已脱敏）。

## 隐私与安全

- **密钥只在宿主进程里用**，不会出现在日志、错误消息或任何响应里；
- AccessKey ID 对外只给掩码形式（如 `LTAI5t...GHY1`）；
- 插件只访问两类目标：你配置的阿里云 BSS 端点，以及 dsh-pet 的本地 `petApi7340` 服务；
  除此之外不向任何地方上报；
- 不写磁盘（AK 文件是你自己放的，插件只读）。

> ⚠️ 把 AccessKey 当成**账单凭据**对待 —— 它能读你的账单与代金券。
> 请让它远离仓库、截图和聊天记录。本仓库的 `.gitignore` 已排除 `qwen-coupon.json`。

## License

[MIT](LICENSE)