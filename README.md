# dsh-token-usage

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com) ![dsh](https://img.shields.io/badge/dsh-0.1.5--rc.1%20~%200.2.1--rc.2-blue)

> 统计**本机全部 DSH 会话**的历史 token 总消耗。与 `dsh-context`（只看单个会话）互补，只回答一个问题：**我一共花了多少 token？**

- 🎯 **全局总量**：跨会话、跨工作区、跨 DSH home 汇总
- 🧹 **正确去重**：按 `message.id` 消除 v0/v3 与 resume/fork 副本（否则虚高约 3 倍）
- 🖥️ **桌面壳优先**：Host 只依赖 Node 内置模块，不导入 `@deepseek-ai/*`
- 🪶 **极简**：不捆绑费用、余额、热力图、宠物
- 🔒 **只读会话日志**：绝不修改会话；只在 `$DSH_HOME/dsh-token-usage/` 写自己的缓存与额度配置，不联网
- 📊 **多维拆分**：模型 / 模型家族 / Provider / 工作区 / 会话 / Token 类型
- 📈 **趋势图**：零依赖 SVG 堆叠柱状图；时间轴随顶部区间自动分桶（1–3 天按小时、4–7 天按 3 小时、8–14 天按 6 小时、15–90 天按天、91–700 天按周、更长按月），空桶补零；悬停明细卡、入场动画、坐标轴字号自适应
- 🗂️ **全页视图**：可在设置里开启左侧栏入口，点开后占满右侧工作区
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

本插件是可本地安装的 bundle，无第三方运行时依赖、已内置构建产物；已发布到 npm：`@liuguangzhe/dsh-token-usage`。

### 从 npm 安装（推荐）

```sh
dsh plugin --profile desktop add @liuguangzhe/dsh-token-usage
```

然后**重启 DSH Desktop**（host 代码与 profile bundle 变更需要重启，刷新页面不够）。

### 从本地源码安装（开发）

在仓库根目录执行：

```sh
dsh plugin --profile desktop add .
```

`.` 指当前目录；如果你在别的目录执行，把 `.` 换成仓库路径（例如 `~/Projects/dsh-token-usage`）。

> 也可以先装到一个隔离 profile 验证：
> ```sh
> dsh plugin --profile plugin-lab add .
> dsh --profile plugin-lab --dump-config   # 应看到 dsh-token-usage 层与插件行
> ```

---

## 使用

### 1. 设置页

重启后打开 **设置 → Token 统计**：

- 总量卡片：合计 / 非缓存输入 / 输出 / 缓存读取 / 调用次数
- **唯一时间控制**：**今天（默认）** / 近 7 天 / 近 30 天 / **自定义日期** / 全部
  - 只填起始：统计起始日到当天
  - 只填截止：统计截止日之前的全部
  - 两者都填：统计该起止区间（含首尾两天）
  - 趋势图和明细表都只跟随这个区间，没有第二套时间控件
- **分组维度**：模型 / 模型家族 / Provider / 工作区 / 会话 / Token 类型
  - 同一个选择同时控制上方趋势图的堆叠图例和下方明细表的分组
- **趋势图**：
  - 时间轴按区间自动分桶：1–3 天按小时、4–7 天按 3 小时、8–14 天按 6 小时、15–90 天按天、91–700 天按周、更长按月
  - 区间内空桶补 0，稀疏数据不会被画成相邻柱；Top 8 系列 + 「其他」
  - 悬停显示 HTML 明细卡（总计 + 各系列），柱体有入场动画，支持 `prefers-reduced-motion`；坐标轴字号按容器宽度自适应
  - 「隐藏图表」可只看明细
- **明细表**：当前区间 + 当前维度的合计 / 占比 / 输入 / 输出 / 缓存读取 / 调用，按合计降序，最多展示前 200 行
- **全页视图（可选）**：勾选「在左侧栏显示」后，左侧栏出现「Token 统计」入口，点开占满右侧工作区；开关保存在本机，关闭即移除入口，不需要重启
- **额度统计卡片**：只列出已配置的接入方，逐行配 启用开关 / 名称 / 额度（亿/万/个）/ 每月刷新日，显示各自本周期已用、剩余与进度条；其余接入方从「＋ 添加接入方」挑选
- 「刷新」「重新扫描」按钮，页面每 30 秒自动刷新

### 2. HTTP API（本机回环）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-token-usage/summary?range=all&groupBy=auto&series=model&fill=1` | 汇总 + 时间桶 + 维度合计 |
| GET | `/dsh-token-usage/quota` | 已配置接入方的额度与本周期已用/剩余，附可添加的候选列表 |
| POST | `/dsh-token-usage/quota` | 保存配置 `{ providers: { <id>: { enabled, amount, unit, refreshDay, label } } }` |
| POST | `/dsh-token-usage/rescan` | 立即重新扫描 |
| GET | `/dsh-token-usage/health` | 扫描状态与覆盖信息 |

`range`：`all`｜`today`｜`7d`｜`30d`｜`month`｜`cycle`（本额度周期）。
也可只传 `from` / `to`（`YYYY-MM-DD`），Host 会自动推断为自定义区间——只传 `from` 表示起始至今，只传 `to` 表示截止之前全部。
`groupBy`：`auto`｜`5m`｜`15m`｜`30m`｜`hour`｜`3h`｜`6h`｜`day`｜`week`｜`month`｜`model`｜`provider`｜`project`｜`session`｜`family`。

`auto` 是设置页趋势图使用的默认值，按时间窗口自动选桶宽：`<=3` 天 `hour`、`<=7` 天 `3h`、`<=14` 天 `6h`、`<=90` 天 `day`、`<=700` 天 `week`、更长 `month`。
显式时间维度（`5m` 到 `month`）默认最多 1000 个桶，超出会自动放粗；响应的 `groupBy` 是实际粒度，只有发生放粗时才附带 `requestedGroupBy`。

- `series=model|family|provider|project|session`：时间分组时附带每桶的 `series` 拆分，以及全局 `seriesOrder`（按总量降序，含 input/output/cacheRead/cacheWrite/reasoning/calls）。
  - `project` 是工作区：key 为完整路径，label 为目录名；`session` 为会话 id；`family` 为模型家族（取模型名的第一段）。
- `fill=1`：时间分组时把区间内的空桶补成 0（图表使用；表格使用 `seriesOrder`，不受影响）。
- `coarsen=0`：禁用 1000 桶自动放粗，返回请求的精确分组（`scripts/report.mjs` 使用）。

### 3. 命令行报表（无需 DSH）

```sh
node scripts/report.mjs                    # Markdown 全量报表
node scripts/report.mjs --range 30d        # 近 30 天
node scripts/report.mjs --from 2026-09-08 --to 2026-09-08 --json
node scripts/report.mjs --group day,model,project
```

---

## 按接入方额度（可选）

多家订阅 / 网关混用时，额度要分开算。卡片里的接入方**与「模型」页已添加的接入方严格一致**——数据源是同一个 LLM 注册表（`ctx.llm.listProviders()`，即模型页渲染「已添加」列表时用的那批已注册接入方）：

- 「模型」页有哪些接入方，这里就有哪些；那里删除，这里也消失；那里新增，这里就出现。
- 卡片**只列出你已配置额度的接入方**，其余通过底部「＋ 添加接入方」挑选（候选项标注了模型页显示名、累计用量与最后使用日期）：

1. 添加后勾选 **启用** 表示该接入方走订阅制、需要统计剩余；不勾选则保留该行但只记录用量、不算剩余。
2. 每行可填 **名称**（可选）、**本月额度**（数值 + 单位：亿 / 万 / 个）、**每月刷新日**（1–31）；不需要时点「移除」。
3. 启用的行只统计**该 provider 自己**的 token 消耗，显示本周期剩余 / 本月额度 / 进度；超额标红。
4. 刷新日按当月天数自动收敛（例如填 31 日，2 月按 28/29 日算）。

> 额度配置按 provider id 存在 `quota.json`：某个接入方暂时从模型页移除时，它不会显示，但配置会保留，等它回到模型页时自动恢复。若 LLM 注册表不可用（例如非 Web 组合），则回退为「`settings.yaml` + 历史用量」推断。全局用量仍可在上方表格的「按 Provider」分组查看。

配置只保存在本机 `$DSH_HOME/dsh-token-usage/quota.json`，不上传、不写入会话。示例：`datagrand` 每月 20 亿、每月 1 日刷新 → 添加该行后额度填 `20`、单位 `亿`、刷新日 `1`；`deepseek-official` 是官方 API 按量计费，不添加或不启用即可。

> 旧版单额度配置会在首次读取时自动迁移到用量最大的接入方，不会丢失。

---

## 配置

在 `cordis.patch.yml` 的插件行上可覆盖（整段 `config` 替换）：

```yaml
- insert:
    - id: dsh-token-usage
      name: '@liuguangzhe/dsh-token-usage'
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
- **兼容声明**：`engines.dsh` 声明支持 `>=0.1.5-rc.1 <=0.2.1-rc.2`，`dsh.compatibility.dshReleases` 列出该区间的 RC 版本（已在 `0.2.1-rc.2` 验证）
- **npm 元数据**：`keywords` 含 `dsh-plugin` / `deepseek-harness`，并声明 `repository` / `homepage` / `bugs`
- **仓库 topic**：已添加 `dsh-plugin`，供市场 discovery 扫描

---

## 兼容性

- DSH 目标版本：**0.1.5-rc.1 ~ 0.2.1-rc.2**（本机 Desktop 为 0.2.1-rc.2）。Host/Client 只使用稳定的 Cordis `ctx.effect` / `ctx.webServer.register` / `ctx.slots` 接口。
- Host 不导入任何 `@deepseek-ai/*`；Client 只 import React，桌面壳可安全加载。
- 已知边界：只统计 `assistant/message` 口径；`compaction/summary` 默认不计（与 `dsh-usage` 账本一致）。

## 发布

- 打 tag 时同时创建 GitHub Release；说明使用中英双语、先中文后英文，格式参考 DSH 的 tag 页面（`中文 | English`、新增/修复、完整更新日志）。

## 许可

MIT
