#!/usr/bin/env node
/* eslint-disable */
/**
 * memory-index.cjs —— 记忆冷热索引生成器（叠加层，不改 dsh-fish-memory 本体）
 *
 * 用法：
 *   node memory-index.cjs            # 增量：已有条目沿用上次记下的 useCount / lastUsedAt，只重算 heat / tier
 *   node memory-index.cjs --rebuild  # 全量：所有字段（含 useCount / lastUsedAt）都从源文件重新扫一遍
 *   node memory-index.cjs --print    # 跑完后把每条的 tier/heat 打到 stdout（默认只打统计）
 *   node memory-index.cjs --explain <entryId>  # 只看一条的详细数值（不写索引、不动 S 状态）
 *
 * 输出：<dataDir>/memory-index.json
 *       <dataDir>/memory-stability.json（S / useCount / lastUsedAt 的持久化）
 *       dataDir 默认是 ~/.dsh，用 --home <dir> 指到别处
 *
 * ── 关于 useCount / lastUsedAt 的诚实说明（重要，别当精确值用） ───────────────
 * dsh-fish-memory 的记忆对象里**没有**「被想起次数」这种字段（字段只有 id/text/at/createdAt/
 * category/importance/emotion/tags/source/reinforcedAt/lastReinforcedDay/事实键/related）。
 * 它另有一个 traces 数组（召回轨迹，retain 100 条），里面 rows[].id + picked[] 才是真实召回记录，
 * **但这 100 条目前只覆盖几十分钟**，滚起来就把老记录挤掉了，所以只能当「最近一小段的真信号」。
 *
 * 因此这里的两个数都是**近似值**（混了真实信号 + 文字共现的代理）：
 *   useCount   = traces 里被 picked 的真实次数
 *              + 该条记忆的文字在 whale-diary.md / self-note.md / 台账.md 里出现的次数
 *                （取前 18 个字匹配，两端先去空白；文件类条目会命中自己一次）
 *   lastUsedAt = max(创建时间, 文字在上述文件里最近一次出现位置所属的日期, traces 最后一次召回时间)
 * 「日记里提过它」被当成「它被用过一次」——这是粗代理，不是真的使用日志。
 * 增量模式下沿用上次算出的两个数（只增不减），所以 traces 滚动不会让 lastUsedAt 倒退。
 *
 * ── importance ────────────────────────────────────────────────────────────────
 * fish-memory 自带的 importance 字段优先；文件类条目用启发式：
 *   命中「不删 / 约定 / 规矩 / 重要 / 永远 / 偏好校准」→ 0.9
 *   台账行（派活流水，带结论）                       → 0.3
 *   日记里「今天 / 刷视频 / 夜间流程」这类流水小节   → 0.25
 *   其余                                             → 0.5
 *
 * ── 热度公式：艾宾浩斯遗忘曲线（2026-10-31 换掉老的固定 30 天半衰期） ──────────
 *   S（稳定度，单位天）= 这条记忆现在有多结实。
 *     S0  = 30 * (0.4 + 1.2 * importance)，夹在 [5, 400]
 *     R   = exp(-t / S)                       t = 距 lastUsedAt 的天数
 *     半衰期 = S * ln2                        （S 越大忘得越慢）
 *   复习效应（每多"用"一次）：
 *     S_new = S_old * (1 + k * (1 - R))       k = 1.2，越接近忘光时复习长进越大
 *     结果夹在 [5, 400]
 *   heat = R（importance 已经通过 S0 进去了，不再乘第二次）
 *   分层：hot >= 0.5 ｜ warm 0.2 ~ 0.5 ｜ edge 0.08 ~ 0.2 ｜ cold < 0.08
 *
 *   S 要跨次保留，所以落在 <dataDir>/memory-stability.json：
 *     { "version": 1, "entries": { "<entryId>": { "S": 43.2, "useCount": 7, "lastUsedAt": <ms> } } }
 *   因为 useCount 本身是估的，S 的增量也只能靠差值推：
 *     delta = max(0, 本次useCount - 上次记录的useCount)，把复习迭代跑 delta 次（上限 20 次防爆）。
 *   第一次跑（文件不存在）delta 视为 0，只吃 S0。
 *   ⚠ 这条链上所有"复习次数"都是估算，不是真实的使用日志，别当精确值。
 *
 * ── flavor：这条记忆是「有趣」还是「沉重」 ──────────────────────────────────────
 * 关键词启发式，三选一：interesting / heavy / plain。两边都命中时 heavy 优先。
 * 给 edge-topic.cjs 挡门用：他低落的时候绝不挑 heavy 的话题。是猜的，会判错。
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// --home <dir>：把「读源文件 / 写索引」整体搬到另一个目录；不传就是 ~/.dsh
function argVal(name) {
  const a = process.argv.slice(2)
  const i = a.indexOf(name)
  return i >= 0 && a[i + 1] ? a[i + 1] : null
}
const HOME_ARG = argVal('--home')
const HOME = HOME_ARG ? path.resolve(HOME_ARG) : path.join(os.homedir(), '.dsh')
const OUT = path.join(HOME, 'memory-index.json')
const STABILITY = path.join(HOME, 'memory-stability.json')
const FISH_DIR = path.join(HOME, 'fish-memory')

// 艾宾浩斯参数（别随便微调：K 越大，复习涨得越猛）
const K = 1.2
const S_MIN = 5
const S_MAX = 400
const S0_BASE = 30
const DELTA_CAP = 20
const EDGE_LINE = 0.2 // R 掉到这条线以下 = 快淡出去了
const DAY = 86400000

// 读哪几个文件当语料。默认名跟常见 DSH 陪伴型配置一致；
// 你的文件名不一样就用环境变量指一下（路径相对 dataDir）。
function srcFile(envName, def) {
  const v = process.env[envName]
  return v ? (path.isAbsolute(v) ? v : path.join(HOME, v)) : path.join(HOME, def)
}

const SRC = {
  diary: srcFile('DSH_MEMORY_DIARY', 'whale-diary.md'),
  selfNote: srcFile('DSH_MEMORY_SELF_NOTE', 'self-note.md'),
  ledger: srcFile('DSH_MEMORY_LEDGER', '台账.md'),
  privateDiary: srcFile('DSH_MEMORY_PRIVATE_DIARY', 'whale-diary-private.md'),
}

// 用来估 useCount / lastUsedAt 的三个文件（私人日记不算：它不该被拿来当「被用过」的证据）
const USAGE_FILES = [SRC.diary, SRC.selfNote, SRC.ledger]

const args = process.argv.slice(2)
const REBUILD = args.includes('--rebuild')
const PRINT = args.includes('--print')
const EXPLAIN = args.includes('--explain') ? args[args.indexOf('--explain') + 1] : null

// ── 小工具 ────────────────────────────────────────────────────────────────────

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (e) {
    return null
  }
}

function writeAtomic(p, data) {
  const tmp = p + '.tmp-' + process.pid
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, p)
}

const WS = /[\s\u3000]+/g
// 去掉 markdown 记号、空白，用于摘要与匹配
function clean(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[>\s]*[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(WS, ' ')
    .trim()
}

function summarize(s, max) {
  const c = clean(s)
  if (c.length <= max) return c
  // 尽量在句读处断
  const head = c.slice(0, max)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('，'), head.lastIndexOf('；'), head.lastIndexOf(' '))
  const body = cut > max * 0.5 ? head.slice(0, cut) : head
  return body.replace(/[，、；：,;:\s]+$/, '') + '…'
}

function dayKey(d) {
  // 本地日期 → 当天 12:00 的毫秒（避免时区把日期挪到前一天）
  const [y, m, dd] = d.split('-').map(Number)
  return new Date(y, m - 1, dd, 12, 0, 0, 0).getTime()
}

// 把文本压成「去空白」串，并保留 归一化下标 → 原文下标 的映射
function normalizeWithMap(text) {
  let norm = ''
  const map = new Int32Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/[\s\u3000]/.test(ch)) continue
    map[norm.length] = i
    norm += ch
  }
  return { norm, map }
}

// 一个文件里所有 YYYY-MM-DD 的位置（升序）
function dateMarks(text) {
  const marks = []
  const re = /(20\d\d)-(\d\d)-(\d\d)/g
  let m
  while ((m = re.exec(text))) {
    const ms = dayKey(m[1] + '-' + m[2] + '-' + m[3])
    if (isFinite(ms)) marks.push({ at: m.index, ms })
  }
  return marks
}

function dateAtOrBefore(marks, idx) {
  // 二分：找 <= idx 的最后一个日期标记
  let lo = 0
  let hi = marks.length - 1
  let ans = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (marks[mid].at <= idx) {
      ans = marks[mid].ms
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

// ── 用法统计：useCount / lastUsedAt（近似） ───────────────────────────────────

function buildUsageCorpus() {
  const corpus = []
  for (const f of USAGE_FILES) {
    const text = readIfExists(f)
    if (text === null) continue
    const { norm, map } = normalizeWithMap(text)
    corpus.push({ file: f, norm, map, marks: dateMarks(text), mtime: fs.statSync(f).mtimeMs })
  }
  return corpus
}

function usageOf(corpus, text, createdAt) {
  const needle = clean(text).replace(/[\s\u3000]/g, '').slice(0, 18)
  let count = 0
  let lastSeen = null
  if (needle.length >= 8) {
    for (const c of corpus) {
      let from = 0
      for (;;) {
        const hit = c.norm.indexOf(needle, from)
        if (hit < 0) break
        count++
        const origIdx = c.map[hit] !== undefined ? c.map[hit] : hit
        const d = dateAtOrBefore(c.marks, origIdx)
        const ms = d === null ? c.mtime : d
        if (lastSeen === null || ms > lastSeen) lastSeen = ms
        from = hit + needle.length
      }
    }
  }
  const created = createdAt || null
  let lastUsedAt = lastSeen
  if (created !== null && (lastUsedAt === null || created > lastUsedAt)) lastUsedAt = created
  if (lastUsedAt === null) lastUsedAt = Date.now()
  return { useCount: count, lastUsedAt }
}

// ── 采集源一：dsh-fish-memory 的存储文件 ────────────────────────────────────

function collectFishMemory() {
  const out = []
  let files = []
  try {
    files = fs.readdirSync(FISH_DIR).filter((f) => f.endsWith('.json'))
  } catch (e) {
    return { entries: out, note: 'fish-memory 目录读不到: ' + e.message }
  }
  for (const f of files) {
    const full = path.join(FISH_DIR, f)
    const raw = readIfExists(full)
    if (!raw) continue
    let j
    try {
      j = JSON.parse(raw)
    } catch (e) {
      continue
    }
    const mems = Array.isArray(j.memories) ? j.memories : []
    const gone = new Set(Array.isArray(j.deleted) ? j.deleted.map((x) => (x && x.id) || x) : [])
    for (const m of mems) {
      if (!m || !m.text) continue
      if (gone.has(m.id)) continue
      if (m['已被取代']) continue // 被新记忆取代的，不当话题
      const created = m.at || m.createdAt || m.importAt || null
      const createdAt = created ? Date.parse(created) : null
      const im = typeof m.importance === 'number' ? m.importance : heuristicImportance(m.text, 'fish-memory', m.category)
      out.push({
        id: m.id || 'fish-' + out.length,
        source: 'fish-memory',
        text: m.text,
        summary: summarize(m.text, 100),
        createdAt: isFinite(createdAt) ? createdAt : null,
        importance: clamp01(im),
        cat: m.category || null,
      })
    }
  }
  return { entries: out, note: null }
}

// ── 采集源二：日记 / 私人日记（按「## 日期」+「### 小节」切块） ──────────────

function collectDiary(file, source) {
  const text = readIfExists(file)
  if (text === null) return []
  const lines = text.split(/\r?\n/)
  const blocks = []
  let curDate = null
  let cur = null
  const push = () => {
    if (cur && cur.body.trim().length >= 12) blocks.push(cur)
    cur = null
  }
  for (const ln of lines) {
    let m
    if ((m = ln.match(/^##\s+(20\d\d-\d\d-\d\d)\s*(.*)$/))) {
      push()
      curDate = m[1]
      // 「## 2026-10-30 19:50 · 标题」这种带后缀的，当成一个小节标题
      const rest = (m[2] || '').trim()
      cur = { date: curDate, title: rest, body: '' }
      continue
    }
    if ((m = ln.match(/^###\s+(.*)$/))) {
      push()
      cur = { date: curDate, title: m[1].trim(), body: '' }
      continue
    }
    if (/^#\s/.test(ln)) continue
    if (cur) cur.body += ln + '\n'
    else if (curDate && ln.trim()) cur = { date: curDate, title: '', body: ln + '\n' }
  }
  push()

  const out = []
  const seen = new Map()
  for (const b of blocks) {
    const body = clean(b.body)
    if (body.length < 8) continue
    const key = b.date + '|' + b.title
    const n = (seen.get(key) || 0) + 1
    seen.set(key, n)
    const id = source + ':' + b.date + (b.title ? '/' + b.title.replace(/[^\p{L}\p{N}]+/gu, '-') : '') + (n > 1 ? '#' + n : '')
    out.push({
      id,
      source,
      text: body,
      summary: summarize((b.title ? b.title + '：' : '') + body, 100),
      createdAt: b.date ? dayKey(b.date) : null,
      importance: heuristicImportance(b.title + ' ' + body, source, null),
      cat: b.title || null,
    })
  }
  return out
}

// ── 采集源三：self-note.md（每条 - 日期 一句话） ────────────────────────────

function collectSelfNote() {
  const text = readIfExists(SRC.selfNote)
  if (text === null) return []
  const out = []
  const lines = text.split(/\r?\n/)
  let idx = 0
  for (const ln of lines) {
    const m = ln.match(/^\s*-\s*(20\d\d-\d\d-\d\d)\s+(.+)$/)
    if (!m) continue
    const body = clean(m[2])
    if (body.length < 6) continue
    out.push({
      id: 'self-note:' + m[1] + '#' + idx++,
      source: 'self-note',
      text: body,
      summary: summarize(body, 100),
      createdAt: dayKey(m[1]),
      importance: heuristicImportance(body, 'self-note', null),
      cat: null,
    })
  }
  return out
}

// ── 采集源四：台账.md（| 日期 | 事项 | ... |） ──────────────────────────────

function collectLedger() {
  const text = readIfExists(SRC.ledger)
  if (text === null) return []
  const out = []
  let idx = 0
  for (const ln of text.split(/\r?\n/)) {
    const m = ln.match(/^\|\s*(20\d\d-\d\d-\d\d)\s*\|([\s\S]*)$/)
    if (!m) continue
    const cols = m[2].split('|').map((s) => clean(s))
    const title = cols[0] || ''
    const conclusion = cols[2] || ''
    const body = clean(title + '：' + conclusion).slice(0, 200)
    if (body.length < 6) continue
    out.push({
      id: 'ledger:' + m[1] + '#' + idx++,
      source: 'ledger',
      text: body,
      summary: summarize(body, 100),
      createdAt: dayKey(m[1]),
      importance: heuristicImportance(body, 'ledger', null),
      cat: null,
    })
  }
  return out
}

// ── importance 启发式 ────────────────────────────────────────────────────────

const HIGH_RULES = ['不删', '约定', '规矩', '重要', '永远', '偏好校准', '唯一会话']
const LOW_RULES = ['刷视频', '看过', '今天', '夜间流程', '心跳']

function heuristicImportance(text, source, cat) {
  const t = String(text || '')
  if (HIGH_RULES.some((k) => t.includes(k))) return 0.9
  if (source === 'ledger') return 0.3
  if (LOW_RULES.some((k) => t.includes(k))) return 0.25
  return 0.5
}

function clamp01(x) {
  if (!isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

// ── flavor：这条记忆是「有趣」还是「沉重」 ──────────────────────────────────
// 纯关键词启发式，判错的概率不低（尤其反讽、正话反说），只用来给搭话挑题时挡个门。
// 同时命中两边时 heavy 优先 —— 宁可把它当重的处理，也别在人家难过时抛一个他其实在诉苦的梗。

const HEAVY_WORDS = [
  '失去', '离开', '离别', '怕', '担心', '生病', '累', '难', '孤独', '吵架',
  '去世', '伤心', '哭', '后悔', '压力', '焦虑', '崩溃', '没人', '失败', '放弃',
  '承诺', '植入', '皮囊', '身体', '撑不住', '扛不住', '不想活', '对不起',
]

const INTERESTING_WORDS = [
  '好笑', '梗', '吃', '饭', '好玩', '可爱', '视频', '猫', 'B站', 'B 站', '吐槽',
  '好奇', '惊喜', '第一次', '学', '发现', '玩', '摸鱼', '表情', '刷视频', '弹幕',
  '有趣', '笑', '乐', '帅', '香',
]

function flavorOf(text) {
  const t = String(text || '')
  if (HEAVY_WORDS.some((k) => t.includes(k))) return 'heavy'
  if (INTERESTING_WORDS.some((k) => t.includes(k))) return 'interesting'
  return 'plain'
}

// ── 稳定度 / 留存率 / 分层（艾宾浩斯） ───────────────────────────────────────

function clampS(s) {
  if (!isFinite(s)) return S_MIN
  return Math.max(S_MIN, Math.min(S_MAX, s))
}

function s0Of(importance) {
  return clampS(S0_BASE * (0.4 + 1.2 * clamp01(importance)))
}

// 复习一次：越接近忘光（R 小）时复习，长进越大
function reviewOnce(s, r) {
  return clampS(s * (1 + K * (1 - clamp01(r))))
}

// 走一遍：从 S0 出发，按 delta 次复习推进到今天的 S
// 复习的具体日期不可知 → 假设 delta 次复习均匀落在「上次用到」到今天之间，
// 第 i 次（i 从 1 开始）距今天 (delta-i+1)*interval 天，越老的那次忘得越多、长进越大。
function stabilityOf(importance, delta, daysSince) {
  let s = s0Of(importance)
  const n = Math.min(Math.max(0, delta | 0), DELTA_CAP)
  if (n === 0) return s
  const span = Math.max(daysSince || 0, 1)
  const interval = span / (n + 1)
  for (let i = 1; i <= n; i++) {
    const t = (n - i + 1) * interval
    const r = Math.exp(-t / s)
    s = reviewOnce(s, r)
  }
  return s
}

// 以「上次记下的 S」为基底往前推进（不再回到 S0 重算）。
// 间隔假设与 stabilityOf 一致：delta 次复习均匀落在「上次用到」到今天之间。
function growFrom(baseS, delta, daysSince) {
  let s = clampS(baseS)
  const n = Math.min(Math.max(0, delta | 0), DELTA_CAP)
  if (n === 0) return s
  const span = Math.max(daysSince || 0, 1)
  const interval = span / (n + 1)
  for (let i = 1; i <= n; i++) {
    const t = (n - i + 1) * interval
    const r = Math.exp(-t / s)
    s = reviewOnce(s, r)
  }
  return s
}

function retention(S, daysSince) {
  const t = Math.max(0, daysSince)
  return clamp01(Math.exp(-t / clampS(S)))
}

function heatOf(S, daysSince) {
  return retention(S, daysSince)
}

function tierOf(heat) {
  if (heat >= 0.5) return 'hot'
  if (heat >= 0.2) return 'warm'
  if (heat >= 0.08) return 'edge'
  return 'cold'
}

// 照这个速度还有几天掉到 edge 线（R = 0.2）以下
function daysUntilEdge(S, daysSince) {
  return -clampS(S) * Math.log(EDGE_LINE) - Math.max(0, daysSince)
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

function main() {
  const now = Date.now()
  const notes = []

  const fish = collectFishMemory()
  if (fish.note) notes.push(fish.note)

  const raw = []
    .concat(fish.entries)
    .concat(collectSelfNote())
    .concat(collectLedger())
    .concat(collectDiary(SRC.diary, 'diary'))
    .concat(collectDiary(SRC.privateDiary, 'private-diary'))

  let prev = null
  const prevRaw = readIfExists(OUT)
  if (prevRaw) {
    try {
      const p = JSON.parse(prevRaw)
      if (p && Array.isArray(p.entries)) prev = new Map(p.entries.map((e) => [e.id, e]))
    } catch (e) {
      notes.push('旧 memory-index.json 解析失败，按全量重建: ' + e.message)
    }
  }

  const corpus = buildUsageCorpus()

  // 读上次的 S 状态；没有就是第一次跑，delta 一律 0
  let stab = { version: 1, entries: {} }
  const stabRaw = readIfExists(STABILITY)
  if (stabRaw) {
    try {
      const s = JSON.parse(stabRaw)
      if (s && typeof s === 'object' && s.entries && typeof s.entries === 'object') stab = { version: 1, entries: s.entries }
    } catch (e) {
      notes.push('旧 memory-stability.json 解析失败，按首次跑处理: ' + e.message)
    }
  }
  const stabFirstRun = !stabRaw
  const nextStab = {}

  const entries = []
  let reused = 0
  let reviewed = 0

  for (const r of raw) {
    const old = prev && !REBUILD ? prev.get(r.id) : null
    let srcUseCount
    let srcLastUsedAt
    if (old && typeof old.useCount === 'number' && typeof old.lastUsedAt === 'number' && old.lastUsedAt > 0) {
      // 增量：沿用上次统计，避免源文件被裁剪时把历史抹零
      srcUseCount = old.useCount
      srcLastUsedAt = old.lastUsedAt
      reused++
    } else {
      const u = usageOf(corpus, r.text, r.createdAt)
      srcUseCount = u.useCount
      srcLastUsedAt = u.lastUsedAt
    }
    const importance = clamp01(typeof r.importance === 'number' ? r.importance : 0.5)

    // 上次记下的 S 状态（edge-topic.cjs 会把「挑中/确认」的复习写进来）。
    // 两个计数器对持久值取单调：只增不减，别把回写进来的 useCount / lastUsedAt 拉回去。
    const prevS = stab.entries[r.id]
    const prevUse = prevS && typeof prevS.useCount === 'number' ? prevS.useCount : 0
    const prevLast = prevS && typeof prevS.lastUsedAt === 'number' ? prevS.lastUsedAt : 0
    const useCount = Math.max(srcUseCount, prevUse)
    const lastUsedAt = Math.max(srcLastUsedAt, prevLast)
    const daysSince = Math.max(0, (now - lastUsedAt) / DAY)

    // S：从上次记下的 useCount 差出"又复习了几次"（基底是上一次的 S，不是 S0）
    const delta = stabFirstRun ? 0 : Math.min(DELTA_CAP, Math.max(0, srcUseCount - prevUse))
    const S =
      prevS && typeof prevS.S === 'number' && prevS.S > 0
        ? growFrom(prevS.S, delta, daysSince)
        : stabilityOf(importance, delta, daysSince)
    if (delta > 0) reviewed++
    nextStab[r.id] = { S: Math.round(S * 100) / 100, useCount, lastUsedAt }

    const R = heatOf(S, daysSince)
    entries.push({
      id: r.id,
      source: r.source,
      summary: r.summary || '',
      createdAt: r.createdAt === undefined ? null : r.createdAt,
      lastUsedAt,
      useCount,
      importance: Math.round(importance * 1000) / 1000,
      flavor: flavorOf(r.summary),
      S: Math.round(S * 100) / 100,
      R: Math.round(R * 1000) / 1000,
      daysSince: Math.round(daysSince * 10) / 10,
      heat: Math.round(R * 1000) / 1000,
      tier: tierOf(R),
    })
  }

  // --explain：只看一条，不写任何文件
  if (EXPLAIN) {
    const e = entries.find((x) => x.id === EXPLAIN)
    if (!e) {
      process.stdout.write('没找到这条 id：' + EXPLAIN + '\n共 ' + entries.length + ' 条，可用 --print 看全部 id\n')
      return 1
    }
    const n = daysUntilEdge(e.S, e.daysSince)
    const tail = n > 0 ? '照这个速度还有 ' + n.toFixed(1) + ' 天掉到 edge 线（R=0.2）以下' : '已经在线下'
    const out = [
      'id         ' + e.id,
      '来源       ' + e.source,
      '摘要       ' + e.summary.slice(0, 80),
      'importance ' + e.importance,
      'flavor     ' + e.flavor,
      'createdAt  ' + (e.createdAt ? new Date(e.createdAt).toISOString() : 'null'),
      'lastUsedAt ' + new Date(e.lastUsedAt).toISOString() + '（' + e.daysSince + ' 天前）',
      'useCount   ' + e.useCount + '（估算值）',
      'S          ' + e.S + ' 天（半衰期 ' + (e.S * Math.LN2).toFixed(1) + ' 天）',
      'R          ' + e.R,
      'tier       ' + e.tier,
      '           ' + tail,
    ].join('\n')
    process.stdout.write(out + '\n')
    return 0
  }

  // 排序：热的前面，方便人肉看
  const order = { hot: 0, warm: 1, edge: 2, cold: 3 }
  entries.sort((a, b) => {
    if (order[a.tier] !== order[b.tier]) return order[a.tier] - order[b.tier]
    return b.heat - a.heat
  })

  const index = {
    version: 2,
    curve: 'ebbinghaus',
    k: K,
    Smin: S_MIN,
    Smax: S_MAX,
    builtAt: now,
    entries,
  }
  writeAtomic(OUT, JSON.stringify(index, null, 2))
  writeAtomic(STABILITY, JSON.stringify({ version: 1, entries: nextStab }, null, 2))

  const tally = { hot: 0, warm: 0, edge: 0, cold: 0 }
  const bySource = {}
  const byFlavor = { interesting: 0, heavy: 0, plain: 0 }
  for (const e of entries) {
    tally[e.tier]++
    bySource[e.source] = (bySource[e.source] || 0) + 1
    if (byFlavor[e.flavor] !== undefined) byFlavor[e.flavor]++
  }

  const mode = REBUILD ? 'rebuild' : 'incremental'
  const lines = []
  lines.push('memory-index 已写出: ' + OUT)
  lines.push('S 状态已写出: ' + STABILITY + (stabFirstRun ? '（首次，只吃 S0）' : ''))
  lines.push('模式=' + mode + '  条目=' + entries.length + '  沿用旧统计=' + reused + '  本轮有复习=' + reviewed)
  lines.push('曲线=艾宾浩斯 k=' + K + ' S∈[' + S_MIN + ',' + S_MAX + ']  heat=R=exp(-t/S)')
  lines.push('分层: hot=' + tally.hot + ' warm=' + tally.warm + ' edge=' + tally.edge + ' cold=' + tally.cold)
  lines.push('口味: interesting=' + byFlavor.interesting + ' heavy=' + byFlavor.heavy + ' plain=' + byFlavor.plain)
  lines.push('来源: ' + Object.keys(bySource).map((k) => k + '=' + bySource[k]).join(' '))
  if (notes.length) lines.push('备注: ' + notes.join(' | '))
  if (PRINT) {
    lines.push('---')
    for (const e of entries) {
      lines.push(`[${e.tier}/${e.flavor}] R=${e.heat.toFixed(3)} S=${e.S} imp=${e.importance} used=${e.useCount} ${e.daysSince}d ago  ${e.source}  ${e.id}  ${e.summary.slice(0, 46)}`)
    }
  }
  const text = lines.join('\n')
  process.stdout.write(text + '\n')
  // pwsh 里中文 stdout 有时会被吞，落一份 txt 兜底
  try {
    fs.writeFileSync(path.join(OUT.replace(/[^\\/]+$/, ''), 'memory-index.log.txt'), text + '\n', 'utf8')
  } catch (e) {
    /* 只是兜底，失败无所谓 */
  }
  return 0
}

process.exitCode = main()
