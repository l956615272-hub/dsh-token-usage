# DSH 全局 Token 消耗统计插件 — 产品需求文档 (PRD)

- 产品名：**dsh-token-usage**
- 版本：v0.1.0 (MVP)
- 日期：2026-09-11
- 形态：DSH (DeepSeek Harness) 插件，Host + Client 双面
- 项目路径：`/Users/d/Personal_Project/dsh-token-usage`

---

## 1. 背景与问题

DSH 现有插件 `dsh-context` 只能查看**单个会话**的上下文/用量。用户希望知道**本机所有对话历史累计消耗了多少 token**，用于：

- 了解总用量与趋势（按天）；
- 知道钱花在哪个模型 / provider / 项目上；
- 跨会话、跨工作区的全局视角。

### 现状调研结论（已完成的竞品分析）

1. 插件市场已有 100+ 个 token/用量类插件，其中约 8~10 个做「跨会话累计」，但**没有一个是「只显示总量」的极简形态**——普遍捆绑费用、余额、热力图、宠物等。
2. 设计最贴合本需求的 `@zoytown/dsh-token` **明确声明不支持 Electron 桌面壳**，而用户正在使用 DSH Desktop。
3. 现成插件普遍存在两个数据坑：
   - **会话重复**：同一会话存在 v0 + v3 两份文件，以及 resume/fork 出来的多份副本，共享同一批 `message.id`；直接累加会虚高约 3 倍。
   - **同一步 usage 上报两次**：streaming 的 `assistant/chunk` 与最终 `assistant/message` 都带 usage；二者只能计一次。

### 差异化定位

> **桌面壳优先 + 极简全局总量 + 经账本验证的正确去重。**

---

## 2. 目标与非目标

### 2.1 目标（MVP）

- G1 一键看到**本机全部会话累计消耗**的 token 总量（输入 / 输出 / 缓存读取 / 调用次数）。
- G2 支持常用时间范围（全部 / 今天 / 近 7 天 / 近 30 天）。
- G3 支持多维度拆分：按天、按模型、按 provider、按项目、按会话。
- G4 数据正确：按 `message.id` 去重，结果与 `dsh-usage` 账本逐项吻合。
- G5 桌面壳（Electron）可安全加载；不联网、不写敏感数据、只读会话日志。

### 2.2 非目标（本期不做）

- 费用 / 余额 / 额度 / 峰谷计价（用户明确只要 token）。
- 热力图、宠物、预算提醒。
- 按 provider 的余额 API 轮询。
- 修改或删除任何会话数据（严格只读）。
- 面向模型的 system prompt 注入。

---

## 3. 用户与使用场景

| 场景 | 用户 | 行为 |
|---|---|---|
| 看总量 | DSH Desktop 用户 | 打开 设置 → Token 统计，看到累计总量卡片 |
| 看趋势 | 同上 | 切换「近 30 天」，看按天表格 |
| 找大户 | 同上 | 按模型 / 项目表格看谁是消耗大头 |
| 命令行出报表 | 开发者 | 运行 `node scripts/report.mjs` 生成 Markdown 报表 |
| 让 Agent 回答 | 对话用户 | （P1）通过 `/tokens` 命令或工具让助手报数 |

---

## 4. 功能需求

### P0（MVP 必须）

| 编号 | 需求 | 说明 |
|---|---|---|
| F1 | 全局聚合引擎 | 扫描所有 DSH home 下的 `sessions/**/session*.jsonl.zstd`，解析全部会话事件 |
| F2 | 多帧 zstd 解码 | 会话日志是多个 zstd 帧拼接；Node 内置解压只出第一帧，必须逐帧解析 |
| F3 | 去重 | 按 `message.id` 全局去重，消除 v0/v3 与 resume/fork 副本 |
| F4 | 口径定义 | `total = input(未命中) + cacheRead + output`；reasoning 只作 output 拆分，不重复计 |
| F5 | 时间范围 | all / today / 7d / 30d，另支持自定义 from~to |
| F6 | 多维分组 | day / model / provider / project / session |
| F7 | 磁盘缓存 | 聚合结果落盘 `$DSH_HOME/dsh-token-usage/cache.json`，重启秒开 |
| F8 | 后台刷新 | 启动后异步全量扫描；之后按固定间隔增量刷新，不阻塞 UI |
| F9 | HTTP API | 提供 `GET /dsh-token-usage/summary`、`POST /dsh-token-usage/rescan`、`GET /dsh-token-usage/health` |
| F10 | 设置页 UI | 设置 → 「Token 统计」：总量卡片 + 范围切换 + 分组表格 + 刷新/重扫按钮 |
| F11 | 独立报表 | `scripts/report.mjs` 无需 DSH 即可生成 Markdown / JSON 报表 |

### P1（增强，做得到就做）

| 编号 | 需求 | 说明 |
|---|---|---|
| F12 | 自定义日期区间 | UI 提供起始/结束日期选择 |
| F13 | 命令 / 工具 | 通过 Cordis `tools` 或 `commands` 让助手查询总量（best-effort，动态导入失败不影响主功能） |
| F14 | 导出 | 从设置页导出 JSON / CSV |

### P2（远期）

- F15 费用估算（多种模型单价表，可开关）。
- F16 与 dsh-context 的会话级数据交叉校验。

---

## 5. 数据口径（合同）

### 5.1 数据来源

- 路径：`<home>/sessions/<workspace>/<session>/session*.jsonl.zstd`
- home 解析顺序：`$DSH_HOME`、`~/.dsh`、`~/.dsh_desktop/<version>`（若存在）、配置项 `homes`。

### 5.2 事件与字段

每条 usage 来自事件 `assistant/message`：

```jsonc
{
  "type": "assistant/message",
  "seq": 46,
  "time": 1789017094541,
  "data": {
    "turn": 1, "step": 1,
    "message": {
      "id": "d9ce1a2f-...",                    // 去重主键
      "source": { "provider": "datagrand", "model": "deepseek-v4-pro" }
    },
    "usage": {
      "inputTokens": 30, "outputTokens": 29,
      "totalTokens": 1339, "cacheReadTokens": 1280
    }
  }
}
```

会话元信息来自 `session` 事件：`{ id, createdAt, cwd, agentPreset }`。

### 5.3 去重规则

1. **主键**：`message.id`。同一 message.id 在多个文件（v0/v3、副本）中出现，只计一次。
2. **只计最终消息**：忽略 `assistant/chunk` 的 usage（与最终消息重复）。实测若把 chunk 也累加，总量会虚高约 3 倍。
3. **compaction/summary**：默认不计入（与 dsh-usage 账本口径一致），保留开关以便后续启用。

### 5.4 聚合口径

| 字段 | 含义 |
|---|---|
| input | 非缓存输入 token（`inputTokens`） |
| output | 输出 token（`outputTokens`） |
| cacheRead | 缓存读取 token（`cacheReadTokens`） |
| cacheWrite | 缓存写入 token（`cacheWriteTokens`，本机为 0） |
| reasoning | 推理 token（`reasoningTokens`，**已包含在 output 内，不重复计**） |
| total | `input + output + cacheRead` |
| calls | 计数的 LLM 调用条数 |
| sessions | 去重后涉及的不同 session 数 |

### 5.5 时区

按 `Asia/Shanghai` 分天（可配置）。使用 `Intl.DateTimeFormat` 计算，不依赖本机进程 TZ。

---

## 6. 信息架构与 UI

### 6.1 设置页（Client）

位置：`设置 → Token 统计`（`settings.section` slot，id 为 `token-usage`）。

布局（自上而下）：

1. **总量卡片**：大号 total（含千分位）；下方 4 个小格：非缓存输入 / 输出 / 缓存读取 / 调用次数。
2. **范围切换**：全部 / 今天 / 近 7 天 / 近 30 天（胶囊按钮）。
3. **分组切换**：按天 / 按模型 / 按项目 / 按 Provider。
4. **分组表格**：列 = 名称 / 合计 / 输入 / 输出 / 缓存读取 / 调用。
5. **页脚**：生成时间、数据覆盖区间、文件数、刷新 / 重新扫描按钮。

状态处理：

- 首次加载显示骨架/“正在统计…”；
- 扫描中显示进度提示；
- 请求失败保留上次成功数据并显示错误；
- 每 30 秒自动刷新一次（in-flight guard + unmount 防护）。

### 6.2 命令行报表

```sh
node scripts/report.mjs                 # Markdown 全量报表
node scripts/report.mjs --range 30d     # 近 30 天
node scripts/report.mjs --json          # 输出 JSON
node scripts/report.mjs --group day,model
```

---

## 7. 技术架构

```
dsh-token-usage/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # 插入插件行
├── lib/
│   ├── index.js          # Host 插件入口（只依赖 node: 内置模块）
│   ├── client.js         # Client 插件（__ModuleLoader__ 包装，仅 require('react')）
│   └── core/
│       ├── zstd.js       # 多帧 zstd 结构解析与解码
│       ├── paths.js      # DSH home 解析
│       ├── scan.js       # 会话文件枚举 / 事件解析 / 记录提取
│       ├── aggregate.js  # 范围过滤 / 汇总 / 分组
│       └── store.js      # 内存快照 + 磁盘缓存 + 周期刷新
├── scripts/report.mjs    # 独立报表 CLI
├── test/                 # node:test 单元与集成测试
├── docs/PRD.md
└── README.md
```

### 7.1 为什么 Host 不导入内核包

桌面壳的 profile `node_modules` 中**没有** `@deepseek-ai/*`（内核从 app.asar 加载），跨包导入存在解析失败风险。因此 Host 只依赖 Node 内置模块，通过 Cordis 注入的 `ctx` 使用 `webServer`。这最大程度保证桌面壳兼容，也避免复制 runtime identity。

### 7.2 关键实现点

- **多帧 zstd**：按 zstd 帧头结构（magic / Frame_Header_Descriptor / Dictionary_ID / Frame_Content_Size / Block 头 / Content_Checksum）计算每帧字节长度，逐帧 `zstdDecompressSync` 后拼接。实测 99 个文件全部完整消费。
- **性能**：解析前先用 `line.includes('"inputTokens"')` 快速过滤，避免 JSON.parse 巨大的 reasoning/tool 事件。全量扫描 61.6MB / 99 文件约 **1.4s**。
- **增量刷新**：记录每个文件的 `mtimeMs + size`，仅重扫变化的文件；文件记录先删除后重建，保证磁盘缓存一致。
- **原子落盘**：临时文件 + `fsync` + `rename`。

---

## 8. 验收标准

| 编号 | 验收项 | 方法 |
|---|---|---|
| A1 | 多帧解码正确 | 单测：两段 `zstdCompressSync` 拼接后解码等于原文 |
| A2 | 去重正确 | 单测：同 message.id 的多条记录只计一次 |
| A3 | 口径正确 | 实盘与 `~/.dsh/dsh-usage/usage-ledger.json` 在 9/8、9/9、9/10 **逐项吻合** |
| A4 | 总量正确 | 全量扫描 records > 0，total = input + output + cacheRead |
| A5 | 桌面壳安全 | Host 不 import 任何 `@deepseek-ai/*`；Client 只 require `react` |
| A6 | 生命周期干净 | 定时器、路由、订阅在卸载时全部释放 |
| A7 | 报表可用 | `node scripts/report.mjs` 生成可读 Markdown |
| A8 | 测试通过 | `node --test "test/**/*.test.mjs"` 全绿 |

---

## 9. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 数据取证与去重口径验证 | ✅ 已完成（与账本对拍） |
| M1 | 核心引擎 + Host API | 本轮 |
| M2 | Client 设置页 | 本轮 |
| M3 | 独立报表 + 测试 + 文档 | 本轮 |
| M4 | 安装到 Desktop profile 并真机验证 | 待用户确认后执行 |
