# dsh-memory-thermal 设计说明

这份文档描述的是 `lib/memory-index.cjs` 与 `lib/edge-topic.cjs` 里**已经跑着**的规则，
参数和阈值都从这两个脚本的头部注释和代码里抄的，不是设想。

---

## 1. 一句话定位

不删记忆，只让记忆按艾宾浩斯曲线慢慢变淡；等它快淡出视野时，挑出来聊一次，它又变结实。
本插件负责两件事：给每条记忆算「现在有多热」，以及在恰当的时机把快淡掉的那条捞回来。

---

## 2. 记忆从哪来

`memory-index.cjs` 扫本机几个文本来源，生成条目：

| 来源 | 默认文件（在 dataDir 下） | 环境变量可覆盖 |
| --- | --- | --- |
| 日记 | `whale-diary.md` | `DSH_MEMORY_DIARY` |
| 私人日记 | `whale-diary-private.md` | `DSH_MEMORY_PRIVATE_DIARY` |
| 自述 | `self-note.md` | `DSH_MEMORY_SELF_NOTE` |
| 台账 | `台账.md` | `DSH_MEMORY_LEDGER` |
| fish-memory 存储 | `fish-memory/` | — |

`dataDir` 默认 `~/.dsh`，用 `--home <dir>` 指到别处。

---

## 3. 稳定度 S 与留存率 R

```
S0        = 30 * (0.4 + 1.2 * importance)      夹在 [5, 400] 天
R         = exp(-t / S)                        t = 距 lastUsedAt 的天数
半衰期    = S * ln2                            S 越大忘得越慢
heat      = R                                  importance 已经进了 S0，不再乘第二次
```

参数常量（两个脚本必须一致，改一边就得改另一边）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `K` | 1.2 | 复习增益系数 |
| `S_MIN` | 5 | 稳定度下限（天） |
| `S_MAX` | 400 | 稳定度上限（天） |
| `S0_BASE` | 30 | S0 的基数 |
| `DELTA_CAP` | 20 | 单轮最多补算多少次复习 |
| `EDGE_LINE` | 0.2 | 「边线」的 R 线 |

### 分层阈值（按 R）

| 层级 | R 区间 | 含义 |
| --- | --- | --- |
| `hot` | R ≥ 0.5 | 还烫着，正常在视野里 |
| `warm` | 0.2 ≤ R < 0.5 | 温的，还记得 |
| `edge` | 0.08 ≤ R < 0.2 | **边线**，快淡出去了，搭话就从这层挑 |
| `cold` | R < 0.08 | 冷的，已经淡出 |

### 还有多少天掉到边线以下

```
daysUntilEdge(S, daysSince) = -S * ln(0.2) - daysSince
```

> 注意这个函数用的是 `EDGE_LINE = 0.2`（memory-index.cjs 里定义的常量），也就是「掉到 warm 与 edge 的交界」。

---

## 4. 复习效应

每「用」一次记忆，S 就长一点，而且**越接近忘记时复习，长进越大**：

```
S_new = S_old * (1 + K * (1 - R))       K = 1.2
S_new 夹在 [5, 400]
```

`R` 越接近 0，`(1-R)` 越接近 1，一次复习最多能把 S 拉到原来的 2.2 倍；
`R` 接近 1 时几乎不涨。

### 复习次数怎么来的（重要，是估的）

`useCount` 不是真实使用日志：

```
useCount   = traces 里被 picked 的真实次数
           + 该条记忆的文字在 whale-diary.md / self-note.md / 台账.md 里出现的次数
             （取前 18 个字匹配，两端先去空白；文件类条目会命中自己一次）
lastUsedAt = max(创建时间, 文字在上述文件里最近一次出现位置所属的日期, traces 最后一次召回时间)
```

增量模式下这两个数沿用上次结果（只增不减），所以 traces 滚动不会让 `lastUsedAt` 倒退。

S 的增量按差值推：

```
delta = min(DELTA_CAP, max(0, 本次 useCount - 上次记录的 useCount))
```

把复习迭代跑 `delta` 次。第一次跑（S 状态文件不存在）`delta` 视为 0，只吃 `S0`。

---

## 5. 心情门（edge-topic.cjs）

心情值 `mood` 是 0–100 的数，越低越沉。分三档：

| 档位 | 条件 | 允许的 flavor | 优先顺序 |
| --- | --- | --- | --- |
| `low` | mood < 40 | 只许 `interesting` / `plain`，`heavy` 硬剔除 | — |
| `normal` | 40 ≤ mood < 70 | 都允许 | `interesting` > `plain` > `heavy` |
| `good` | mood ≥ 70 | 都允许 | `heavy` 优先 |
| `unknown` | 读不到心情 | 不挡门，退回全部候选 | — |

低落档里如果过门后一条不剩，就**宁可不搭话**，输出 `EMPTY`，不硬塞一条重的。

阈值可用 `--mood-low` / `--mood-high` 或环境变量 `EDGE_MOOD_LOW` / `EDGE_MOOD_HIGH` 覆盖。

心情源三种给法，越靠前越优先：

1. `--mood-endpoint <完整 URL>` / `EDGE_MOOD_ENDPOINT`
2. `--mood-path <路径>` / `EDGE_MOOD_PATH`（自己去猜端口，拼成 `http://127.0.0.1:<port><path>`）
3. 都没给 → 只翻 dataDir 下名字像 mood 的 json，翻不到就当「读不到」

一条都没配的时候**绝不乱扫端口**。

---

## 6. 节律与挑人顺序

默认间隔 **5.5 天（475200000 ms）**，用 `--interval <毫秒>` 覆盖。

挑人顺序：

1. `tier === 'edge'` 里挑，排除最近 20 次（`KEEP_FIRED`）挑过的
2. `edge` 空了 → `cold` 里 `heat` 最高的 3 条里随机
3. `edge` 和 `cold` 都空（语料太新时就是这种情况）→ 全表 `heat` 最低的 5 条里随机，
   并在输出里标注「还没有记忆老到边线上，先挑最冷的一条练手」

**挑出来本身就是一次复习**：挑中那一刻立刻回写一次 S 长进，并把这次动作记进
`pending.steps`（`kind: 'pick'`）。之后 `--reviewed` 再补一次（`kind: 'review'`），
`--undo-review` 按步骤倒着撤。

---

## 7. 状态文件格式

全部落在 `dataDir`（默认 `~/.dsh`）下，都是运行态产物，已在 `.gitignore` 里排除。

### `memory-index.json`

```json
{
  "version": 2,
  "curve": "ebbinghaus",
  "k": 1.2,
  "Smin": 5,
  "Smax": 400,
  "builtAt": 0,
  "entries": [
    {
      "id": "string",
      "source": "diary | privateDiary | selfNote | ledger | fish-memory",
      "summary": "string",
      "createdAt": 0,
      "lastUsedAt": 0,
      "useCount": 0,
      "importance": 0.5,
      "flavor": "interesting | heavy | plain",
      "S": 30,
      "R": 1,
      "daysSince": 0,
      "heat": 1,
      "tier": "hot | warm | edge | cold"
    }
  ]
}
```

### `memory-stability.json`（S 的持久化）

```json
{
  "version": 1,
  "entries": {
    "<entryId>": { "S": 43.2, "useCount": 7, "lastUsedAt": 0 }
  }
}
```

### `edge-talk-state.json`

```json
{
  "lastFiredAt": 0,
  "fired": [{ "at": 0, "entryId": "string", "summary": "string" }],
  "pending": {
    "entryId": "string",
    "firedAt": 0,
    "R": 0.12,
    "steps": [
      {
        "kind": "pick | review",
        "entryId": "string",
        "at": 0,
        "R": 0.12,
        "hadEntry": true,
        "before": { "S": 30, "useCount": 3, "lastUsedAt": 0 },
        "after": { "S": 45.6, "useCount": 4, "lastUsedAt": 0 }
      }
    ]
  }
}
```

`fired` 只保留最近 20 条。

### `edge-topic.txt`

挑出来的那段话的纯文本副本，给不方便读 stdout 的场合兜底。

---

## 8. 命令行

### memory-index.cjs

```
node lib/memory-index.cjs                  # 增量：沿用上次 useCount / lastUsedAt，只重算 heat / tier
node lib/memory-index.cjs --rebuild        # 全量：所有字段都从源文件重扫
node lib/memory-index.cjs --print          # 跑完把每条的 tier/heat 打到 stdout
node lib/memory-index.cjs --explain <id>   # 只看一条的详细数值（不写索引、不动 S 状态）
```

`--explain` 会打印 id / 来源 / 摘要 / importance / flavor / createdAt / lastUsedAt /
useCount / S（含半衰期）/ R / tier，最后一行是「照这个速度还有 N 天掉到 edge 线（R=0.2）以下」。

### edge-topic.cjs

```
node lib/edge-topic.cjs                    # 正常跑：没到点就 SKIP，到点就挑一条
node lib/edge-topic.cjs --dry-run          # 空跑：完整走一遍但不写状态、不写 txt
node lib/edge-topic.cjs --force            # 无视间隔，立刻挑（测试用，仍写状态）
node lib/edge-topic.cjs --force --dry-run  # 立刻挑但什么都不写
node lib/edge-topic.cjs --reviewed         # 聊过了，再涨一次 S
node lib/edge-topic.cjs --undo-review      # 撤销上一次复习回写
```

其它参数：`--home <dir>`、`--interval <毫秒>`、`--mood-endpoint <url>`、`--mood-path <path>`。

---

## 9. flavor 是怎么判的

纯关键词启发式，三选一，两边都命中时 **heavy 优先**（宁可当重的处理）：

- `heavy`：失去 / 离开 / 离别 / 怕 / 担心 / 生病 / 累 / 难 / 孤独 / 吵架 / 去世 / 伤心 / 哭 /
  后悔 / 压力 / 焦虑 / 崩溃 / 没人 / 失败 / 放弃 / 承诺 / 植入 / 皮囊 / 身体 / 撑不住 /
  扛不住 / 不想活 / 对不起
- `interesting`：好笑 / 梗 / 吃 / 饭 / 好玩 / 可爱 / 视频 / 猫 / B站 / B 站 / 吐槽 / 好奇 /
  惊喜 / 第一次 / 学 / 发现 / 玩 / 摸鱼 / 表情 / 刷视频 / 弹幕 / 有趣 / 笑 / 乐 / 帅 / 香
- 其余 → `plain`

反讽、正话反说会判错，这是已知的。

---

## 10. 诚实的三条局限

1. **`useCount` 不是真使用日志。** 它是「召回轨迹 + 文字共现」的代理，
   `S` 的增量也跟着是估的。可以当趋势看，别当精确值用。
2. **`flavor` 是关键词猜的。** 会误判，尤其是反讽和正话反说。心情门因此只能挡「明显重的」，挡不住「看起来轻其实很重」。
3. **5.5 天这个节律是拍的，不是调出来的。** 没有任何数据支撑这个数字，它就是个没人验证过的先验。
