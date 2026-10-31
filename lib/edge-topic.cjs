#!/usr/bin/env node
/* eslint-disable */
/**
 * edge-topic.cjs —— 「边线记忆」搭话选题器
 *
 * 干什么：隔一段时间（默认 5.5 天）从记忆冷热索引里挑一条快淡出去的记忆，
 *         生成一段话，让模型拿它当话题找用户聊。聊一次 = 复习一次，它就重新结实。
 *
 * 用法：
 *   node edge-topic.cjs             # 正常跑：没到点就 SKIP，到点就挑一条
 *   node edge-topic.cjs --dry-run   # 空跑：完整走一遍但不写状态、不写 txt
 *   node edge-topic.cjs --force     # 无视间隔，立刻挑（测试用，仍写状态）
 *   node edge-topic.cjs --force --dry-run  # 立刻挑但什么都不写
 *   node edge-topic.cjs --reviewed  # 聊过了，再涨一次 S
 *   node edge-topic.cjs --undo-review      # 撤销上一次复习回写
 *
 * 读：<dataDir>/memory-index.json（没有就先跑一次 memory-index.cjs --rebuild）
 * 写：<dataDir>/edge-talk-state.json   状态（lastFiredAt + 最近 20 次挑过的）
 *     <dataDir>/edge-topic.txt          挑出来的那段话
 *     dataDir 默认 ~/.dsh，用 --home 指到别处；间隔用 --interval <毫秒> 调
 *
 * 挑人顺序：
 *   1. tier === 'edge' 里挑，排除最近 20 次挑过的
 *   2. edge 空了 → cold 里 heat 最高的 3 条里随机
 *   3. edge 和 cold 都空（语料太新时就是这种情况）→ 全表 heat 最低的 5 条里随机，
 *      并在输出里标注「还没有记忆老到边线上，先挑最冷的一条练手」
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

// --home <dir>：把索引/状态/txt 搬到另一个目录；不传就是 ~/.dsh
function argVal(name) {
  const a = process.argv.slice(2)
  const i = a.indexOf(name)
  return i >= 0 && a[i + 1] ? a[i + 1] : null
}
const HOME_ARG = argVal('--home')
const HOME = HOME_ARG ? path.resolve(HOME_ARG) : path.join(os.homedir(), '.dsh')
const INDEX = path.join(HOME, 'memory-index.json')
// 生成器跟本脚本放在同一个目录（lib/），不依赖外面有没有 bin/
const GENERATOR = path.join(__dirname, 'memory-index.cjs')
const STATE = path.join(HOME, 'edge-talk-state.json')
const TOPIC_TXT = path.join(HOME, 'edge-topic.txt')
const STABILITY = path.join(HOME, 'memory-stability.json')

const DAY = 86400000
// --interval <毫秒>：默认 5.5 天（475200000）。想改节奏就传这个，别去改文件
const INTERVAL_ARG = argVal('--interval')
const INTERVAL_MS =
  INTERVAL_ARG !== null && isFinite(Number(INTERVAL_ARG)) && Number(INTERVAL_ARG) > 0
    ? Number(INTERVAL_ARG)
    : 475200000 // 5.5 天
const KEEP_FIRED = 20
const EDGE_LINE = 0.2

// 跟 memory-index.cjs 同一套艾宾浩斯参数（改这里就得改那边，别走偏）
const K = 1.2
const S_MIN = 5
const S_MAX = 400

function clampS(s) {
  if (!isFinite(s)) return S_MIN
  return Math.max(S_MIN, Math.min(S_MAX, s))
}

function retention(S, tDays) {
  return Math.max(0, Math.min(1, Math.exp(-Math.max(0, tDays) / clampS(S))))
}

function reviewOnce(S, R) {
  return clampS(S * (1 + K * (1 - Math.max(0, Math.min(1, R)))))
}

// 心情门限：mood 是 0-100 的数，越低越沉
let MOOD_LOW = 40 // < 40 低落：只许聊 interesting，heavy 一条都不许
let MOOD_HIGH = 70 // >= 70 不错：interesting / heavy 都行，heavy 优先
// 40 ~ 70 平常：interesting 优先，没有才允许 heavy
// --mood-low / --mood-high 或环境变量 EDGE_MOOD_LOW / EDGE_MOOD_HIGH 可覆盖
if (process.env.EDGE_MOOD_LOW) MOOD_LOW = Number(process.env.EDGE_MOOD_LOW)
if (process.env.EDGE_MOOD_HIGH) MOOD_HIGH = Number(process.env.EDGE_MOOD_HIGH)

const MOOD_HTTP_TIMEOUT = 900
// 心情源的三种给法（越靠前越优先）：
//   ① --mood-endpoint <完整 URL> / EDGE_MOOD_ENDPOINT  → 只读它
//   ② --mood-path <路径> / EDGE_MOOD_PATH              → 自己去猜端口，拼成 http://127.0.0.1:<port><path>
//   ③ 都没给 → 只翻 dataDir 下名字像 mood 的 json，翻不到就当「读不到」
// 一条都没配的时候绝不乱扫端口：这是别人的机器，不该到处敲门。
const MOOD_ENDPOINT = (argVal('--mood-endpoint') || process.env.EDGE_MOOD_ENDPOINT || '').trim()
const MOOD_URL_PATH = (argVal('--mood-path') || process.env.EDGE_MOOD_PATH || '').trim()
// 端口候选：DSH_WEB_URL 里的端口 + EDGE_MOOD_PORTS（逗号分隔）
const MOOD_PORT_ENV = (process.env.EDGE_MOOD_PORTS || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0 && n < 65536)

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const FORCE = args.includes('--force')
const REVIEWED = args.includes('--reviewed')
const UNDO_REVIEW = args.includes('--undo-review')

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    return null
  }
}

function writeJson(p, obj) {
  const tmp = p + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

// ── 持久化稳定度 S（跟 memory-index.cjs 共用同一份文件） ─────────────────────
// 结构 { version:1, entries:{ <entryId>:{ S, useCount, lastUsedAt } } }
// 写回时保留别的条目，只动自己这一条。
function readStability() {
  const s = readJson(STABILITY)
  if (s && typeof s === 'object' && s.entries && typeof s.entries === 'object' && !Array.isArray(s.entries)) {
    return { version: 1, entries: s.entries }
  }
  return { version: 1, entries: {} }
}

function writeStability(stab) {
  writeJson(STABILITY, { version: 1, entries: stab.entries })
}

function stabOf(stab, entryId) {
  const e = stab.entries[entryId]
  if (!e || typeof e !== 'object') return null
  const S = typeof e.S === 'number' && e.S > 0 ? e.S : null
  const useCount = typeof e.useCount === 'number' ? e.useCount : 0
  const lastUsedAt = typeof e.lastUsedAt === 'number' && e.lastUsedAt > 0 ? e.lastUsedAt : null
  if (S === null) return null
  return { S, useCount, lastUsedAt }
}

function briefOf(v) {
  if (!v) return { S: null, useCount: null, lastUsedAt: null }
  return { S: v.S, useCount: v.useCount, lastUsedAt: v.lastUsedAt }
}

// 离 edge 线还有几天：R = exp(-t/S) = 0.2 → t = -S*ln(0.2)
function daysUntilEdge(entry) {
  const S = typeof entry.S === 'number' && entry.S > 0 ? entry.S : 30
  const t = typeof entry.daysSince === 'number' ? entry.daysSince : 0
  return -S * Math.log(EDGE_LINE) - t
}

function pickOne(list) {
  if (!list.length) return null
  return list[Math.floor(Math.random() * list.length)]
}

// ── 读用户的心情 ──────────────────────────────────────────────────────────────
// 来源按顺序试：① --mood-endpoint / EDGE_MOOD_ENDPOINT 给的完整 URL
//              ② --mood-path / EDGE_MOOD_PATH + 已知端口（DSH_WEB_URL、EDGE_MOOD_PORTS）
//              ③ dataDir 下跟 mood 有关的 json
// 全读不到就返回 { kind:'unknown' }，绝不抛错退出。

function httpGetJson(url, timeoutMs) {
  const http = require('http')
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return finish(null)
        }
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            finish(JSON.parse(buf))
          } catch (e) {
            finish(null)
          }
        })
      })
      req.on('timeout', () => {
        req.destroy()
        finish(null)
      })
      req.on('error', () => finish(null))
    } catch (e) {
      finish(null)
    }
  })
}

function portsFromEnv() {
  const out = []
  const u = process.env.DSH_WEB_URL || ''
  const m = /:(\d{2,5})/.exec(u)
  if (m) out.push(Number(m[1]))
  for (const p of MOOD_PORT_ENV) out.push(p)
  return out
}

// 端口只从「自己声明的」地方来：DSH_WEB_URL 和 EDGE_MOOD_PORTS。
// 原来这里会 netstat 把本机所有监听端口敲一遍 —— 别人的机器上那是骚扰，
// 而且读到的也未必是心情源，删掉。
function moodPorts() {
  const seen = new Set()
  const out = []
  for (const p of portsFromEnv()) {
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

function moodFromJson(obj) {
  if (!obj || typeof obj !== 'object') return null
  // 优先单条；如果是多 slot 的结构就取第一个有 mood 的
  const cands = []
  if (typeof obj.mood === 'number') cands.push(obj)
  if (Array.isArray(obj.slots)) for (const s of obj.slots) if (s && typeof s.mood === 'number') cands.push(s)
  if (!cands.length) return null
  const c = cands[0]
  let neg = 0
  if (Array.isArray(c.dims)) {
    for (const d of c.dims) {
      if (!d) continue
      if (['sad', 'worry', 'heartache', 'jealous'].includes(d.key) && typeof d.value === 'number') neg += d.value
    }
  }
  let mood = c.mood
  // 负面情绪计数压一下（每条负面最多压 8 分，只压不抬）
  if (neg > 0) mood = Math.max(0, mood - Math.min(24, neg * 4))
  return { mood: Math.round(mood), label: c.moodLabel || '', emoji: c.emoji || '', raw: c.mood }
}

function readMoodFiles() {
  const dir = HOME
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => /mood|feiyu|feeling|emotion/i.test(n) && /\.json$/i.test(n))
  } catch (e) {
    return null
  }
  for (const n of names) {
    const o = readJson(path.join(dir, n))
    const m = moodFromJson(o)
    if (m) return Object.assign(m, { src: 'file:' + n })
  }
  return null
}

async function readMood() {
  // EDGE_MOOD_DISABLE=1 强行当成读不到（验 unknown 档用，不影响正常跑）
  if (process.env.EDGE_MOOD_DISABLE === '1') return { mood: null, kind: 'unknown', src: 'none(disabled)', tried: [] }
  const tried = []
  // ① 给了完整 URL 就只读它
  if (MOOD_ENDPOINT) {
    const m = moodFromJson(await httpGetJson(MOOD_ENDPOINT, MOOD_HTTP_TIMEOUT))
    if (m) return Object.assign(m, { src: MOOD_ENDPOINT })
    return { mood: null, kind: 'unknown', src: 'none(endpoint 没读到)', tried: [] }
  }
  // ② 给了路径就去试自己知道的端口
  if (MOOD_URL_PATH) {
    for (const p of moodPorts()) {
      const url = 'http://127.0.0.1:' + p + MOOD_URL_PATH
      tried.push(p)
      const o = await httpGetJson(url, MOOD_HTTP_TIMEOUT)
      const m = moodFromJson(o)
      if (m) return Object.assign(m, { src: url })
    }
  }
  // ③ 都没有：只翻 dataDir 里名字像 mood 的 json
  const f = readMoodFiles()
  if (f) return f
  return { mood: null, kind: 'unknown', src: 'none', tried }
}

function moodTier(mood) {
  if (typeof mood !== 'number' || !isFinite(mood)) return 'unknown'
  if (mood < MOOD_LOW) return 'low'
  if (mood >= MOOD_HIGH) return 'good'
  return 'normal'
}

// 这一档允许哪些 flavor，以及优先顺序
function flavorPolicy(tier) {
  if (tier === 'low') {
    // 硬门：低落时 heavy 一条都不许，宁可这次不搭话
    return {
      allow: ['interesting', 'plain'],
      order: ['interesting', 'plain'],
      line: '他现在状态不太好，别聊重的东西',
    }
  }
  if (tier === 'good') {
    return {
      allow: ['interesting', 'heavy', 'plain'],
      order: ['heavy', 'interesting', 'plain'],
      line: '他今天还行，聊点有分量的也没关系',
    }
  }
  if (tier === 'unknown') {
    return {
      allow: ['interesting', 'heavy', 'plain'],
      order: ['interesting', 'heavy', 'plain'],
      line: '没读到他的心情，按平常办',
    }
  }
  return {
    allow: ['interesting', 'heavy', 'plain'],
    order: ['interesting', 'heavy', 'plain'],
    line: '他现在状态一般，这条别往深处带',
  }
}

// ── 复习回写：挑中 → 真聊过（--reviewed）→ 可撤销（--undo-review） ──────────
// 挑中那一刻就先记一次 S 长进（挑出来本身就是一次回忆触发）；
// 真跟用户聊过之后再涨一次。两次都记在 state.pending.steps 里，能逐级回退。

function lastStep(steps) {
  return steps.length ? steps[steps.length - 1] : null
}

// --reviewed：真聊过了，再涨一次 S。刻意复用挑中时算的 R：
// 挑中到确认只隔几分钟，若按当下重算 R≈1，(1-R)≈0 增量就是 0，这次确认等于白记。
// 所以沿用 pending.R（挑中那一刻的遗忘程度），让它代表「这条本来快忘了，今天被用起来了」。
function handleReviewed(state, now) {
  const pending = state.pending
  if (!pending || !pending.entryId) {
    process.stdout.write('REVIEWED 没有待确认的话题\n')
    return 0
  }
  const steps = Array.isArray(pending.steps) ? pending.steps : []
  const lstep = lastStep(steps)
  if (lstep && lstep.kind === 'reviewed') {
    process.stdout.write('已经确认过了，不重复涨\n')
    return 0
  }

  const stab = readStability()
  const cur = stabOf(stab, pending.entryId) || (lstep && lstep.after ? lstep.after : null) || (lstep && lstep.before ? lstep.before : null)
  if (!cur) {
    process.stdout.write('REVIEWED 找不到这条的 S 状态（' + pending.entryId + '）\n')
    return 0
  }
  const R = typeof pending.R === 'number' && isFinite(pending.R) ? Math.max(0, Math.min(1, pending.R)) : 0
  const before = { S: cur.S, useCount: cur.useCount, lastUsedAt: cur.lastUsedAt }
  const after = {
    S: Math.round(reviewOnce(cur.S, R) * 100) / 100,
    useCount: (typeof cur.useCount === 'number' ? cur.useCount : 0) + 1,
    lastUsedAt: now,
  }
  const hadEntry = !!(stab.entries[pending.entryId] && typeof stab.entries[pending.entryId] === 'object')

  if (!DRY) {
    stab.entries[pending.entryId] = after
    writeStability(stab)
    steps.push({ kind: 'reviewed', entryId: pending.entryId, at: now, R, hadEntry, before, after })
    pending.steps = steps
    state.pending = pending
    writeJson(STATE, state)
  }

  const out = [
    'REVIEWED 已确认: ' + pending.entryId,
    '复习回写: S ' + before.S + ' → ' + after.S + '（R=' + R.toFixed(3) + ', useCount ' + before.useCount + '→' + after.useCount + '）',
  ]
  if (DRY) out.push('（--dry-run：没写盘）')
  process.stdout.write(out.join('\n') + '\n')
  return 0
}

// --undo-review：撤销最后一步复习，可连续调用（先撤 reviewed 再撤 pick）
function handleUndo(state, now) {
  const pending = state.pending
  const steps = pending && Array.isArray(pending.steps) ? pending.steps : []
  if (!pending || !pending.entryId) {
    process.stdout.write('UNDO 没有可撤销的复习\n')
    return 0
  }
  if (!steps.length) {
    process.stdout.write('UNDO pending 里没有步骤，已清空\n')
    if (!DRY) {
      state.pending = null
      writeJson(STATE, state)
    }
    return 0
  }

  const step = steps.pop()
  const stab = readStability()
  if (step.hadEntry === false) {
    delete stab.entries[step.entryId]
  } else if (step.before) {
    stab.entries[step.entryId] = {
      S: step.before.S,
      useCount: step.before.useCount,
      lastUsedAt: step.before.lastUsedAt,
    }
  }
  if (!DRY) {
    writeStability(stab)
    if (!steps.length) state.pending = null
    else {
      pending.steps = steps
      state.pending = pending
    }
    writeJson(STATE, state)
  }

  const b = step.before || {}
  const out = [
    'UNDO 撤销了一步 ' + step.kind + '（' + step.entryId + '）',
    '恢复后: S=' + b.S + ' useCount=' + b.useCount + ' lastUsedAt=' + (b.lastUsedAt ? new Date(b.lastUsedAt).toISOString() : 'null') +
      '  剩余步骤=' + steps.length,
  ]
  if (DRY) out.push('（--dry-run：没写盘）')
  process.stdout.write(out.join('\n') + '\n')
  return 0
}

async function main() {
  // 0. 复习回写模式：跟挑话题无关，先处理（不碰 lastFiredAt，冷却语义不变）
  if (REVIEWED || UNDO_REVIEW) {
    const now0 = Date.now()
    const st0 = readJson(STATE) || { lastFiredAt: null, fired: [] }
    if (!Array.isArray(st0.fired)) st0.fired = []
    if (st0.lastFiredAt === undefined) st0.lastFiredAt = null
    if (REVIEWED) return handleReviewed(st0, now0)
    return handleUndo(st0, now0)
  }

  // 1. 索引不存在就先建
  let index = readJson(INDEX)
  if (!index || !Array.isArray(index.entries)) {
    // 永远带上 --home：生成器跟本脚本必须写同一个目录，不然索引会跑到默认位置去
    const genArgs = [GENERATOR, '--rebuild', '--home', HOME]
    const r = spawnSync(process.execPath, genArgs, { encoding: 'utf8' })
    if (r.status !== 0) {
      process.stdout.write('ERROR 索引不存在且重建失败：' + (r.stderr || r.status) + '\n')
      return 1
    }
    index = readJson(INDEX)
    if (!index || !Array.isArray(index.entries)) {
      process.stdout.write('ERROR 重建后仍读不到 memory-index.json\n')
      return 1
    }
  }

  const entries = index.entries.filter((e) => e && e.id)
  const now = Date.now()

  const state = readJson(STATE) || { lastFiredAt: null, fired: [] }
  const fired = Array.isArray(state.fired) ? state.fired.slice(-KEEP_FIRED) : []
  const firedIds = new Set(fired.map((f) => f && f.entryId).filter(Boolean))

  const tally = { hot: 0, warm: 0, edge: 0, cold: 0 }
  for (const e of entries) if (tally[e.tier] !== undefined) tally[e.tier]++

  const head = '总条数=' + entries.length + '  hot=' + tally.hot + ' warm=' + tally.warm + ' edge=' + tally.edge + ' cold=' + tally.cold
  const out = [head]

  // 2. 没到点就走人，不动状态
  const last = typeof state.lastFiredAt === 'number' ? state.lastFiredAt : null
  if (!FORCE && last !== null && now - last < INTERVAL_MS) {
    const left = (INTERVAL_MS - (now - last)) / DAY
    process.stdout.write(head + '\nSKIP 还没到（上次 ' + new Date(last).toISOString() + '，还要 ' + left.toFixed(1) + ' 天）\n')
    return 0
  }

  // 3. 先看心情，定下允许哪些 flavor
  const mood = await readMood()
  const tier = moodTier(mood.mood)
  const policy = flavorPolicy(tier)
  const tierName = { low: '低落', normal: '平常', good: '不错', unknown: '未知' }[tier]
  const moodShown =
    typeof mood.mood === 'number'
      ? mood.mood + (mood.label ? '（' + mood.label + '）' : '') + ' 来自 ' + mood.src + (typeof mood.raw === 'number' && mood.raw !== mood.mood ? '，原始 mood=' + mood.raw : '')
      : '读不到（试过 ' + (mood.tried && mood.tried.length ? mood.tried.length + ' 个端口' : '端口和文件都没找到') + '）'

  // 4. 挑人（先按 tier 建池，再按 flavor 过心情门）
  let pool = []
  let note = ''
  let mode = ''

  const edgePool = entries.filter((e) => e.tier === 'edge' && !firedIds.has(e.id))
  if (edgePool.length) {
    pool = edgePool
    mode = 'edge'
  } else {
    const coldPool = entries.filter((e) => e.tier === 'cold')
    if (coldPool.length) {
      coldPool.sort((a, b) => b.heat - a.heat)
      pool = coldPool.slice(0, 3)
      mode = 'cold'
      note = '（edge 空了，从 cold 里挑 heat 最高的几条）'
    } else {
      const byHeat = entries.slice().sort((a, b) => a.heat - b.heat)
      pool = byHeat.slice(0, 5)
      mode = 'coldest-any'
      note = '（还没有记忆老到边线上，先挑最冷的一条练手）'
    }
  }

  const beforeGate = pool.slice()
  // 心情门：低落时 heavy 直接剔除（硬门），其余档按 order 优先，不硬剔
  let gated = pool.filter((e) => policy.allow.includes(e.flavor))
  let gateNote = ''
  if (tier === 'low') {
    const dropped = beforeGate.length - gated.length
    if (dropped > 0) gateNote = '（心情门挡掉 ' + dropped + ' 条 heavy）'
    if (!gated.length) {
      // 低落时宁可不搭话，也不硬塞一条重的
      out.push('心情=' + tierName + ' 值=' + moodShown)
      out.push('允许=' + policy.allow.join('/') + '  ' + policy.line)
      out.push('EMPTY 低落且候选里没有 interesting/plain 的，这次不搭话')
      process.stdout.write(out.join('\n') + '\n')
      if (!DRY) writeJson(STATE, { lastFiredAt: now, fired: fired.slice(-KEEP_FIRED), pending: state.pending || null })
      return 0
    }
  } else if (!gated.length) {
    gated = pool.slice()
    gateNote = '（没有符合心情口味的，退回全部候选）'
  }

  const byFlavor = { interesting: 0, heavy: 0, plain: 0 }
  for (const e of gated) if (byFlavor[e.flavor] !== undefined) byFlavor[e.flavor]++
  const poolFlavor = { interesting: 0, heavy: 0, plain: 0 }
  for (const e of beforeGate) if (poolFlavor[e.flavor] !== undefined) poolFlavor[e.flavor]++

  // 按 order 分组：优先口味非空就只在那一组里挑
  let chosen = null
  for (const f of policy.order) {
    const g = gated.filter((e) => e.flavor === f)
    if (g.length) {
      chosen = pickOne(g)
      break
    }
  }
  if (!chosen) chosen = pickOne(gated)

  // 5. 一条都没有
  if (!chosen) {
    out.push('心情=' + tierName + ' 值=' + moodShown)
    out.push('EMPTY 没有可挑的记忆')
    process.stdout.write(out.join('\n') + '\n')
    if (!DRY) {
      writeJson(STATE, { lastFiredAt: now, fired: fired.slice(-KEEP_FIRED), pending: state.pending || null })
    }
    return 0
  }
  const n = Math.max(0, Math.round(chosen.daysSince || 0))
  const m = Math.max(0, Math.round(daysUntilEdge(chosen)))

  const text = [
    '【老记忆搭话】有一条记忆快淡出去了：' + chosen.summary +
      '（来自 ' + chosen.source + '，上次用到大概 ' + n + ' 天前，还剩大概 ' + m + ' 天掉到线下面）',
    '你可以拿它当话题找用户聊，自然一点，别像在汇报。聊完不用交代这是哪来的。',
    '口味：' + (chosen.flavor === 'heavy' ? '这条偏重，别急着劝，先听' : chosen.flavor === 'interesting' ? '这条轻，可以放开聊' : '这条中性') +
      '。' + policy.line + '。',
  ].join('\n')

  out.push('心情档=' + tierName + '  值=' + moodShown)
  out.push('允许的 flavor=' + policy.allow.join('/') + '（优先 ' + policy.order.join(' > ') + '）  ' + policy.line)
  out.push('候选池按口味: interesting=' + poolFlavor.interesting + ' heavy=' + poolFlavor.heavy + ' plain=' + poolFlavor.plain +
    '  → 过心情门后: interesting=' + byFlavor.interesting + ' heavy=' + byFlavor.heavy + ' plain=' + byFlavor.plain)
  out.push('挑法=' + mode + ' 候选=' + beforeGate.length + (note ? ' ' + note : '') + (gateNote ? ' ' + gateNote : ''))
  out.push('挑了: [' + chosen.tier + '/' + chosen.flavor + '] R=' + chosen.heat + ' S=' + chosen.S + ' ' + chosen.id)

  // ── 挑中那一刻的复习回写：挑出来本身就是一次回忆触发，先记一次 S 长进 ──
  const stab = readStability()
  const prevRec = stabOf(stab, chosen.id)
  const hadEntry = !!(stab.entries[chosen.id] && typeof stab.entries[chosen.id] === 'object')
  const baseRec = prevRec || {
    S: typeof chosen.S === 'number' && chosen.S > 0 ? chosen.S : 30,
    useCount: typeof chosen.useCount === 'number' ? chosen.useCount : 0,
    lastUsedAt: typeof chosen.lastUsedAt === 'number' && chosen.lastUsedAt > 0 ? chosen.lastUsedAt : now,
  }
  const beforeRec = { S: baseRec.S, useCount: baseRec.useCount, lastUsedAt: baseRec.lastUsedAt }
  const tOld = Math.max(0, (now - (baseRec.lastUsedAt || now)) / DAY)
  const Rold = retention(baseRec.S, tOld)
  const afterRec = {
    S: Math.round(reviewOnce(baseRec.S, Rold) * 100) / 100,
    useCount: baseRec.useCount + 1,
    lastUsedAt: now,
  }

  out.push('复习回写: S ' + beforeRec.S + ' → ' + afterRec.S + '（R=' + Rold.toFixed(3) + ', useCount ' + beforeRec.useCount + '→' + afterRec.useCount + '）')
  out.push('---')
  out.push(text)

  process.stdout.write(out.join('\n') + '\n')

  if (!DRY) {
    stab.entries[chosen.id] = {
      S: afterRec.S,
      useCount: afterRec.useCount,
      lastUsedAt: afterRec.lastUsedAt,
    }
    writeStability(stab)
    writeJson(STATE, {
      lastFiredAt: now,
      fired: fired.concat([{ at: now, entryId: chosen.id, summary: chosen.summary || '' }]).slice(-KEEP_FIRED),
      pending: {
        entryId: chosen.id,
        firedAt: now,
        R: Rold,
        steps: [
          {
            kind: 'pick',
            entryId: chosen.id,
            at: now,
            R: Rold,
            hadEntry,
            before: beforeRec,
            after: { S: afterRec.S, useCount: afterRec.useCount, lastUsedAt: afterRec.lastUsedAt },
          },
        ],
      },
    })
    try {
      fs.writeFileSync(TOPIC_TXT, text + '\n', 'utf8')
    } catch (e) {
      process.stdout.write('WARN 写 edge-topic.txt 失败: ' + e.message + '\n')
    }
  } else {
    process.stdout.write('（--dry-run：没写状态，也没写 edge-topic.txt）\n')
  }
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    process.stdout.write('ERROR ' + (e && e.stack ? e.stack : e) + '\n')
    process.exitCode = 1
  },
)
