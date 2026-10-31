# dsh-memory-thermal

**记忆冷热 + 艾宾浩斯遗忘 + 边线搭话** —— 给 AI 的长期记忆做一层「温度」，不删，只让它慢慢变淡。

> 一条记忆不会因为过期就被扔掉，它会像人脑里那样一点点退到边线；等快淡没了，才被想起来一次。

---

## 它解决什么问题

AI 的记忆有两种常见做法，都不太好：

- **全塞进上下文**：不会忘，但贵、慢，而且越堆越糊。
- **到期就删**：干脆，但无情——昨天还重要的事，今天就没影了。

这是第三条路：**不删，只淡；快淡没了才被想起来一次。**

每条记忆有一个「现在有多热」的数值。热的正常待在视野里，温的还在，**边线上的**（R 在 0.08～0.2 之间）就是「快忘了但还没忘」的那一档。系统隔几天从这一层里挑一条出来当话题聊——聊一次，它就又结实一点。

---

## 三个机制

### 1. 艾宾浩斯遗忘曲线

```
S0 = 30 * (0.4 + 1.2 * importance)     # 初始稳定度，夹在 [5, 400] 天
R  = exp(-t / S)                       # 留存率，t = 距上次用到的天数
半衰期 = S * ln2
```

`S` 是「这条记忆有多结实」，`R` 是「现在还留得住多少」。重要的事 `S0` 大、忘得慢，半衰期天然跟着重要度变化。

按 `R` 分四层：

| 层级 | R | 意思 |
| --- | --- | --- |
| `hot` | ≥ 0.5 | 还烫着 |
| `warm` | 0.2 ~ 0.5 | 温的，还记得 |
| `edge` | 0.08 ~ 0.2 | **边线**，快淡出去了 |
| `cold` | < 0.08 | 冷的，淡出视野 |

### 2. 复习效应

```
S_new = S_old * (1 + 1.2 * (1 - R))
```

**越接近忘光时复习，长进越大。** `R` 快到 0 时复习一次最多能把 `S` 拉到 2.2 倍；`R` 还接近 1（刚用过）时，几乎不涨。这跟人复习的直觉是一样的：刚看完的东西再看一遍没用，快忘的时候捡回来才管用。

### 3. 边线搭话

隔 **5.5 天**，从 `edge` 层里挑一条快被忘掉的记忆，生成一段话让模型拿它当话题——自然点聊，别像汇报。聊完这条 `S` 又涨一次，往 `warm` 走。

带**心情门**：读得到心情值时

- **< 40 低落**：沉重话题硬剔除，一条都不许挑；如果过门后一条不剩，宁可不搭话
- **40 ~ 70 平常**：都允许，轻的优先
- **≥ 70 不错**：重的也可以聊

读不到心情就不挡门，按平常办。

---

## 和 dsh-fish-memory（优尤的「鱼的记忆」）是什么关系

**不冲突，可以并存，各管一件事。**

| | dsh-fish-memory | dsh-memory-thermal（本插件） |
| --- | --- | --- |
| 管什么 | **还说不说** | **找不找得到** |
| 怎么做 | 按鲜活度衰减，淡了就不出现在每轮的视野里 | 算冷热层级，把「捞出来复习」这件事自动化 |
| 结果 | 不该说的时候它自己沉下去 | 快忘的那条会被挑出来聊一次，重新变结实 |

一个管**入场**，一个管**归档与回捞**。同时开着不打架。

---

## 三条局限（诚实写在这）

1. **`useCount` 不是真的使用日志。** 它是「召回轨迹 + 文档里文字共现」的代理值，`S` 的增量也跟着是估的。可以看趋势，别当精确数字用。
2. **`flavor`（有趣 / 沉重）是关键词猜的。** 反讽、正话反说会判错。心情门只能挡「看起来明显重的」，挡不住「看着轻其实很重」。
3. **5.5 天这个节律是拍的，不是调出来的。** 没有任何数据支撑，就是个没人验证过的先验，随时可以 `--interval` 改。

---

## 安装与用法

不需要 `npm install`，没有依赖，只要 Node ≥ 18。

```bash
git clone https://github.com/火鱼艾/dsh-memory-thermal.git
cd dsh-memory-thermal
```

### 两个脚本可以单独跑

先建索引（扫日记 / 自述 / 台账 / fish-memory 存储）：

```bash
node lib/memory-index.cjs --rebuild --print   # 全量重扫并打印全表
node lib/memory-index.cjs                     # 增量：只重算冷热
node lib/memory-index.cjs --explain <entryId> # 看某一条：S / R / 层级 / 还有几天掉线
```

再挑边线话题：

```bash
node lib/edge-topic.cjs                       # 没到点会 SKIP，到点挑一条
node lib/edge-topic.cjs --dry-run             # 空跑：走一遍但不写状态
node lib/edge-topic.cjs --force               # 无视间隔立刻挑（测试用）
node lib/edge-topic.cjs --reviewed            # 聊过了，再涨一次 S
node lib/edge-topic.cjs --undo-review         # 撤销上一次复习
```

数据目录默认 `~/.dsh`，用 `--home <dir>` 指到别处；节律用 `--interval <毫秒>` 调。

### 插件形态

`index.js` 是薄壳：导出 `{ name, apply(ctx), tools }`，两个工具 `memory_heat` / `memory_edge`，
内部**用子进程跑上面两个脚本**、把 stdout 交回去，引擎逻辑一行没重写。

> **工具注册部分按 DSH 插件规范二次接入。** 不同 DSH 版本的注册签名不一样，这里没有去猜、也没有编 API：
> `apply()` 只把工具清单交出来，接入时把 `tools[].handler` 挂到对应版本的注册接口上就行。

也可以用代码直接调：

```js
const thermal = require('./index.js')

// 全表
console.log(thermal.memoryHeat({}).stdout)

// 单条
console.log(thermal.memoryHeat({ entryId: 'diary:2026-10-30:12' }).stdout)

// 挑一条边线记忆（空跑，不写状态）
console.log(thermal.memoryEdge({ dryRun: true }).stdout)
```

---

## 文件结构

```
dsh-memory-thermal/
├── index.js              # 插件入口（薄壳，调 lib 下两个脚本）
├── package.json
├── README.md
├── LICENSE               # MIT
├── .gitignore
├── docs/
│   └── design.md         # 设计说明：阈值、公式、状态文件格式
└── lib/
    ├── memory-index.cjs  # 扫记忆 → 冷热索引
    └── edge-topic.cjs    # 边线选题 → 搭话
```

运行态产物（`memory-index.json`、`memory-stability.json`、`edge-talk-state.json`、`edge-topic.txt`）不入库，已写进 `.gitignore`。

---

## License

MIT © 2026 huoyuai (火鱼艾)
