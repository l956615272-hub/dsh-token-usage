# dsh-token-usage

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com) ![dsh](https://img.shields.io/badge/dsh-0.1.5--rc.1-blue)

> 统计**本机全部 DSH 会话**的历史 token 总消耗。与 `dsh-context`（只看单个会话）互补，只回答一个问题：**我一共花了多少 token？**

- 🎯 **全局总量**：跨会话、跨工作区、跨 DSH home 汇总
- 🧹 **正确去重**：按 `message.id` 消除 v0/v3 与 resume/fork 副本（否则虚高约 3 倍）
- 🖥️ **桌面壳优先**：Host 只依赖 Node 内置模块，不导入 `@deepseek-ai/*`
- 🪶 **极简**：不捆绑费用、余额、热力图、宠物
- 🔒 **只读会话日志**：绝不修改会话；只在 `$DSH_HOME/dsh-token-usage/` 写自己的缓存与额度配置，不联网
- 📊 **多维拆分**：按天 / 模型 / Provider / 项目 / 会话
- 📅 **自定义日期**：只填起始 = 起始日至今；只填截止 = 截止日之前全部；都填 = 该区间
- 🎫 **按接入方额度**：只列出已配置的接入方，其余从「添加接入方」挑选；各自额度/刷新日/启用开关，分开统计剩余
- ⚡ **快**：61.6MB / 99 个会话文件全量扫描约 **1.4s**，结果落盘缓存

---

## 它统计什么

数据来自会话日志中每条最终 assistant 消息的 `usage` 字段：

| 字段 | 含义 |
|---|---|
| input | 非缓存输入 token |
| output | 输出 token（reasoning 已含在内） |
| cacheRead | 缓存读取 token |
| **total** | **input + output + cacheRead** |
| calls | LLM 调用次数 |

> 同一步的 streaming `assistant/chunk` usage 与最终 `assistant/message` usage 重复，只计后者。该口径已与 `dsh-usage` 账本逐项对拍验证（9/8、9/9、9/10 完全吻合）。

---

## 安装

本插件是可本地安装的 bundle，无第三方运行时依赖、已内置构建产物。

### 安装到 Desktop profile（推荐）

```sh
dsh plugin --profile desktop add /Users/d/Personal_Project/dsh-token-usage
```

然后**重启 DSH Desktop**（host 代码与 profile bundle 变更需要重启，刷新页面不够）。

> 也可以先装到一个隔离 profile 验证：
> ```sh
> dsh plugin --profile plugin-lab add /Users/d/Personal_Project/dsh-token-usage
> dsh --profile plugin-lab --dump-config   # 应看到 dsh-token-usage 层与插件行
> ```

### 发布到 npm 后

```sh
dsh plugin --profile desktop add dsh-token-usage
```

---

## 使用

### 1. 设置页

重启后打开 **设置 → Token 统计**：

- 总量卡片：合计 / 非缓存输入 / 输出 / 缓存读取 / 调用次数
- 范围切换：全部 / 今天 / 近 7 天 / 近 30 天 / **自定义日期**
  - 只填起始：统计起始日到当天
  - 只填截止：统计截止日之前的全部
  - 两者都填：统计该起止区间（含首尾两天）
- 分组切换：按天 / 按模型 / 按项目 / 按 Provider
- **额度统计卡片**：只列出已配置的接入方，逐行配 启用开关 / 名称 / 额度（亿/万/个）/ 每月刷新日，显示各自本周期已用、剩余与进度条；其余接入方从「＋ 添加接入方」挑选
- 「刷新」「重新扫描」按钮，页面每 30 秒自动刷新

### 2. HTTP API（本机回环）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-token-usage/summary?range=all&groupBy=day` | 汇总 + 分组 |
| GET | `/dsh-token-usage/quota` | 已配置接入方的额度与本周期已用/剩余，附可添加的候选列表 |
| POST | `/dsh-token-usage/quota` | 保存配置 `{ providers: { <id>: { enabled, amount, unit, refreshDay, label } } }` |
| POST | `/dsh-token-usage/rescan` | 立即重新扫描 |
| GET | `/dsh-token-usage/health` | 扫描状态与覆盖信息 |

`range`：`all`｜`today`｜`7d`｜`30d`｜`month`｜`cycle`（本额度周期）。
也可只传 `from` / `to`（`YYYY-MM-DD`），Host 会自动推断为自定义区间——只传 `from` 表示起始至今，只传 `to` 表示截止之前全部。
`groupBy`：`day`｜`model`｜`provider`｜`project`｜`session`。

### 3. 命令行报表（无需 DSH）

```sh
node scripts/report.mjs                    # Markdown 全量报表
node scripts/report.mjs --range 30d        # 近 30 天
node scripts/report.mjs --from 2026-09-08 --to 2026-09-08 --json
node scripts/report.mjs --group day,model,project
```

---

## 按接入方额度（可选）

多家订阅 / 网关混用时，额度要分开算。卡片**只列出你已配置额度的接入方**，其余通过底部「＋ 添加接入方」挑选（候选项来自实际用量记录 + `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers`，并标注累计用量与最后使用日期）：

1. 添加后勾选 **启用** 表示该接入方走订阅制、需要统计剩余；不勾选则保留该行但只记录用量、不算剩余。
2. 每行可填 **名称**（可选）、**本月额度**（数值 + 单位：亿 / 万 / 个）、**每月刷新日**（1–31）；不需要时点「移除」。
3. 启用的行只统计**该 provider 自己**的 token 消耗，显示本周期剩余 / 本月额度 / 进度；超额标红。
4. 刷新日按当月天数自动收敛（例如填 31 日，2 月按 28/29 日算）。

> **为什么不自动列出全部接入方？** 因为候选来源之一是**历史会话日志**：你删掉某个模型接入配置后，旧会话里记录的 `source.provider` 不会消失。所以删除过的接入方不会自动出现在卡片上，只会作为「添加接入方」的候选（带最后使用日期）；全局用量仍可在上方表格的「按 Provider」分组查看。

配置只保存在本机 `$DSH_HOME/dsh-token-usage/quota.json`，不上传、不写入会话。示例：`datagrand` 每月 20 亿、每月 1 日刷新 → 添加该行后额度填 `20`、单位 `亿`、刷新日 `1`；`deepseek-official` 是官方 API 按量计费，不添加或不启用即可。

> 旧版单额度配置会在首次读取时自动迁移到用量最大的接入方，不会丢失。

---

## 配置

在 `cordis.patch.yml` 的插件行上可覆盖（整段 `config` 替换）：

```yaml
- insert:
    - id: dsh-token-usage
      name: dsh-token-usage
      config:
        timeZone: Asia/Shanghai     # 分天时区
        scanIntervalMs: 60000       # 后台增量刷新间隔
        cache: true                 # 结果落盘缓存
        homes: []                  # 额外扫描的 DSH home（默认自动发现）
```

---

## 工作原理

```
lib/
├── index.js          # Host：扫描生命周期 + HTTP 路由
├── client.js         # Client：设置页 UI（__ModuleLoader__，仅 require('react')）
└── core/
    ├── zstd.js       # 多帧 zstd 结构解析与逐帧解码
    ├── paths.js      # 发现所有 DSH home
    ├── scan.js       # 会话枚举 + usage 提取 + message.id 去重
    ├── aggregate.js  # 时区分天 / 范围过滤 / 汇总 / 分组
    └── store.js      # 内存快照 + 磁盘缓存 + 增量刷新
```

难点与对策：

1. **多帧 zstd**：会话日志是多帧拼接，Node 内置解压只出第一帧。本插件按帧头结构计算每帧长度，逐帧解压后拼接（99 个文件全部完整消费）。
2. **重复会话**：v0 + v3、resume/fork 副本共享同一批 `message.id`，直接累加约虚高 3 倍。按 `message.id` 全局去重。
3. **重复上报**：忽略 `assistant/chunk` 的 usage，只计 `assistant/message`。
4. **桌面壳兼容**：profile 的 `node_modules` 不含 `@deepseek-ai/*`，因此 Host 零内核导入。

---

## 开发与验证

```sh
node --test "test/**/*.test.mjs"   # 12 项测试
node scripts/report.mjs            # 端到端报表
```

验证矩阵：

| 验收项 | 方法 | 结果 |
|---|---|---|
| 多帧 zstd 解码 | 单测：两帧拼接解码等于原文 | ✅ |
| message.id 去重 | 单测：v0/v3 副本折叠为 1 条 | ✅ |
| 口径正确 | 实盘 vs `~/.dsh/dsh-usage/usage-ledger.json`（9/8、9/9、9/10） | ✅ 逐项吻合 |
| Host 路由 | 单测：注册 4 条路由并返回 JSON | ✅ |
| Client 贡献 | 单测：注册 `settings.section` | ✅ |
| 自定义区间 | 单测：单边/双边窗口与 cycle 刷新日（含 2 月收敛） | ✅ |
| 按接入方额度 | 单测：已配置/候选项分离、合成 provider 隔离计费、启用开关、配置落盘、旧配置迁移 | ✅ |
| 性能 | 61.6MB / 99 文件全量扫描 | ✅ ~1.4s |

---

## 插件规范与生态

本项目按 DSH 插件规范声明，可用 `dsh plugin add` 安装，也可被插件市场索引：

- **bundle 清单**（可安装的必要条件）：`dsh.bundle.patch` 指向 `cordis.patch.yml`
- **client 清单**：`dsh.client.platform = "web"`，浏览器半通过 `exports["./client"]` 暴露
- **兼容声明**：`dsh.compatibility.dshReleases` 标注已在 `0.1.5-rc.1` 验证
- **npm 元数据**：`keywords` 含 `dsh-plugin` / `deepseek-harness`，并声明 `repository` / `homepage` / `bugs`
- **仓库 topic**：已添加 `dsh-plugin`，供市场 discovery 扫描

---

## 兼容性

- DSH 目标版本：**0.1.5-rc.1**（本机 Desktop）。Host/Client 只使用稳定的 Cordis `ctx.effect` / `ctx.webServer.register` / `ctx.slots` 接口。
- Host 不导入任何 `@deepseek-ai/*`；Client 只 import React，桌面壳可安全加载。
- 已知边界：只统计 `assistant/message` 口径；`compaction/summary` 默认不计（与 `dsh-usage` 账本一致）。

## 许可

MIT
