# 会话费用（dsh-session-cost）

在 DSH 输入框下方的状态行里显示**当前会话花费**，按每一步实际使用的模型计价：DeepSeek 官方路由按中国区人民币峰谷价，其他模型按 models.dev 的美元价，两个币种分列。

## 功能

- 在 `conversation.composer.dock` 增加金额小标签，位于会话用量之后。
- 点击标签打开明细：按模型分组，列出未缓存输入、缓存读取/写入、输出，以及高峰/空闲分档与单价。
- 金额随会话事件更新；中途切换模型后，前后两段分别按各自模型计价。
- 未知模型只累计 token，不编造金额，并标注“未定价”。
- 价格不写入会话记录，每次按当前价目重算。

## 要求

- DeepSeek Harness `0.2.2-rc.1` 或更新的 `0.2.x`
- DSH Desktop 或 DSH Web 界面
- 首次启动需要访问两个公开价目源（见“联网与缓存”）；离线时使用内置价目

## 安装

在 DSH 的**插件**页选择**添加插件**，输入：

```text
github:RokyZevon/dsh-session-cost
```

或使用 `dsh` CLI：

```bash
dsh plugin --profile desktop add 'github:RokyZevon/dsh-session-cost'
```

安装的是默认分支 `main` 在安装时的 HEAD。DSH 不提供 Git 安装的原位更新；更新时先移除，再重新安装。

## 计价

- **DeepSeek 官方路由**（provider 含 `deepseek`）：按 DeepSeek 中国区官方人民币价目，单位元/百万 tokens，区分高峰/空闲。高峰为北京时间周一至周五 09:00–12:00、14:00–18:00；周末与法定节假日按空闲价。调休上班的周末仍按周末处理。
- **其他路由**：models.dev 收录的模型按美元价目，单位美元/百万 tokens；未收录的模型只列 token。
- 不换汇，人民币与美元分别累计。
- DeepSeek 官方价目中缓存写入为 0 元。
- 每次请求按 `step/start` 所在时刻归入高峰或空闲；一步跨档时按起点计。

## 联网与缓存

后台读取两个公开价目源，缓存在 24 小时内复用，过期后刷新：

- <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
- <https://models.dev/api.json>

只读取价目，不上传会话内容，也没有遥测。价目缓存在 `$DSH_HOME/cache/session-cost/catalog.json`；网络失败时保留上一次价目或内置种子，界面会显示价目日期。

## 已知限制

- 标题生成、网页搜索/抓取产生的平台费用不在会话用量事件里，因此不计入。
- 子代理（subagent）各有独立会话，金额不合并。
- 未知模型无法定价，只列 token。
- 运行中刷新价目后，空闲页面上的金额要等下一条会话事件或刷新页面才更新。
- 节假日表覆盖到 2027-12-31；之后按“仅工作日/周末”估算，界面会提示。
- 金额是按公开价目估算，实际账单以 DeepSeek 和各模型提供方为准。

## 开发

这个仓库就是安装包本身。把目录链接进 profile 后修改文件，Client 半侧会热更新：

```bash
dsh plugin --profile desktop add /path/to/dsh-session-cost
```

离线自检（合成用例不需要网络；回放真实会话日志还需要 `zstd` 和日志文件）：

```bash
node tools/replay-check.js
```

## 结构

- `index.js` — Host 半侧：注册 `sessionCost` 投影，维护价目刷新。
- `fold.js` — 纯函数 token 账本，回放与测试复用。
- `pricing.js` — 官方 CNY 价目、峰谷判定、法定节假日。
- `catalog.js` — 价目目录：内置种子 → 磁盘缓存 → 后台刷新。
- `client.js` — Client 半侧：金额标签与明细弹层。
- `tools/replay-check.js` — 离线自检，不随包分发。

## 许可

MIT
