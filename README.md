# dsh-token-usage

> 统计**本机全部 DSH 会话**的历史 token 总消耗。与 `dsh-context`（只看单个会话）互补，只回答一个问题：**我一共花了多少 token？**

- 🎯 **全局总量**：跨会话、跨工作区、跨 DSH home 汇总
- 🧹 **正确去重**：按 `message.id` 消除 v0/v3 与 resume/fork 副本（否则虚高约 3 倍）
- 🖥️ **桌面壳优先**：Host 只依赖 Node 内置模块，不导入 `@deepseek-ai/*`
- 🪶 **极简**：不捆绑费用、余额、热力图、宠物
- 🔒 **只读**：仅读取会话日志，不写、不改、不联网
- 📊 **多维拆分**：按天 / 模型 / Provider / 项目 / 会话
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
- 范围切换：全部 / 今天 / 近 7 天 / 近 30 天
- 分组切换：按天 / 按模型 / 按项目 / 按 Provider
- 「刷新」「重新扫描」按钮，页面每 30 秒自动刷新

### 2. HTTP API（本机回环）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-token-usage/summary?range=all&groupBy=day` | 汇总 + 分组 |
| POST | `/dsh-token-usage/rescan` | 立即重新扫描 |
| GET | `/dsh-token-usage/health` | 扫描状态与覆盖信息 |

`range`：`all`｜`today`｜`7d`｜`30d`｜`month`，或配合 `from=YYYY-MM-DD&to=YYYY-MM-DD`。
`groupBy`：`day`｜`model`｜`provider`｜`project`｜`session`。

### 3. 命令行报表（无需 DSH）

```sh
node scripts/report.mjs                    # Markdown 全量报表
node scripts/report.mjs --range 30d        # 近 30 天
node scripts/report.mjs --from 2026-09-08 --to 2026-09-08 --json
node scripts/report.mjs --group day,model,project
```

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
node --test "test/**/*.test.mjs"   # 8 项测试
node scripts/report.mjs            # 端到端报表
```

验证矩阵：

| 验收项 | 方法 | 结果 |
|---|---|---|
| 多帧 zstd 解码 | 单测：两帧拼接解码等于原文 | ✅ |
| message.id 去重 | 单测：v0/v3 副本折叠为 1 条 | ✅ |
| 口径正确 | 实盘 vs `~/.dsh/dsh-usage/usage-ledger.json`（9/8、9/9、9/10） | ✅ 逐项吻合 |
| Host 路由 | 单测：注册 3 条路由并返回 JSON | ✅ |
| Client 贡献 | 单测：注册 `settings.section` | ✅ |
| 性能 | 61.6MB / 99 文件全量扫描 | ✅ ~1.4s |

---

## 兼容性

- DSH 目标版本：**0.1.5-rc.1**（本机 Desktop）。Host/Client 只使用稳定的 Cordis `ctx.effect` / `ctx.webServer.register` / `ctx.slots` 接口。
- Host 不导入任何 `@deepseek-ai/*`；Client 只 import React，桌面壳可安全加载。
- 已知边界：只统计 `assistant/message` 口径；`compaction/summary` 默认不计（与 `dsh-usage` 账本一致）。

## 许可

MIT
