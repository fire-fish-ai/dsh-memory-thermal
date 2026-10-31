#!/usr/bin/env node
/* eslint-disable */
/**
 * dsh-memory-thermal —— DSH 插件入口（薄壳）
 *
 * 这里只做两件事：
 *   1. 用子进程（process.execPath）去跑 lib/memory-index.cjs / lib/edge-topic.cjs，
 *      把它们的 stdout 原样交回去 —— 引擎逻辑一行都不重写；
 *   2. 把这两个动作包成两个工具函数：memory_heat / memory_edge。
 *
 * 工具注册那一步（apply）保持最简：本仓里没有去猜 DSH 宿主的具体注册签名，
 * 只导出 { name, version, apply, tools }。接到具体 DSH 版本时，在 apply 里把
 * tools 里的每个工具按该版本的规范挂上去即可，别在这里编 API。
 */

'use strict'

const path = require('path')
const { spawnSync } = require('child_process')

const LIB = path.join(__dirname, 'lib')
const MEMORY_INDEX = path.join(LIB, 'memory-index.cjs')
const EDGE_TOPIC = path.join(LIB, 'edge-topic.cjs')

// 子进程统一用当前这个 node（process.execPath），不依赖 PATH 里有没有 node
function runScript(scriptPath, argv, opts) {
  const options = opts || {}
  const timeout = typeof options.timeout === 'number' ? options.timeout : 120000
  const res = spawnSync(process.execPath, [scriptPath].concat(argv || []), {
    cwd: path.dirname(scriptPath),
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: Object.assign({}, process.env),
  })

  if (res.error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: String(res.error && res.error.message ? res.error.message : res.error),
      script: path.basename(scriptPath),
    }
  }

  return {
    exitCode: typeof res.status === 'number' ? res.status : 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    script: path.basename(scriptPath),
  }
}

// --home 之类的前置参数：只在调用方显式给了的时候透传
function homeArgs(options) {
  const out = []
  if (options && options.home) out.push('--home', String(options.home))
  return out
}

/**
 * memory_heat —— 看某一条（或全表）记忆的冷热
 *
 * @param {object} [args]
 * @param {string} [args.entryId]  给了就只看这一条（--explain），不给就看全表（--print）
 * @param {string} [args.home]     数据目录，默认 ~/.dsh（透传 --home）
 * @param {boolean} [args.rebuild] 全量重扫源文件（--rebuild）
 * @returns {{exitCode:number, stdout:string, stderr:string, script:string, args:string[]}}
 */
function memoryHeat(args) {
  const a = args || {}
  const argv = homeArgs(a)
  if (a.rebuild) argv.push('--rebuild')

  if (a.entryId) {
    argv.push('--explain', String(a.entryId))
  } else {
    argv.push('--print')
  }

  const r = runScript(MEMORY_INDEX, argv, a)
  r.args = argv
  return r
}

/**
 * memory_edge —— 挑一条快淡出去的记忆当本次话题
 *
 * @param {object} [args]
 * @param {boolean} [args.dryRun] 空跑：完整走一遍但不写状态、不写 txt（--dry-run）
 * @param {string}  [args.home]   数据目录，默认 ~/.dsh
 * @param {number}  [args.interval] 覆盖间隔毫秒（--interval）
 * @param {string}  [args.moodEndpoint] 心情源完整 URL（--mood-endpoint）
 * @returns {{exitCode:number, stdout:string, stderr:string, script:string, args:string[]}}
 */
function memoryEdge(args) {
  const a = args || {}
  const argv = homeArgs(a)
  if (a.interval) argv.push('--interval', String(a.interval))
  if (a.moodEndpoint) argv.push('--mood-endpoint', String(a.moodEndpoint))
  if (a.dryRun) argv.push('--dry-run')

  const r = runScript(EDGE_TOPIC, argv, a)
  r.args = argv
  return r
}

// 工具的声明式描述：宿主按自己的规范把它挂上去就行，签名不用猜
const tools = [
  {
    name: 'memory_heat',
    description:
      '查看记忆冷热：给 entryId 看单条的 S（稳定度）/R（留存率）/层级/还有多少天掉到边线以下，不给就看全表。',
    parameters: {
      type: 'object',
      properties: {
        entryId: { type: 'string', description: '可选，记忆条目 id；不给则返回全表' },
        home: { type: 'string', description: '可选，数据目录，默认 ~/.dsh' },
        rebuild: { type: 'boolean', description: '可选，全量重扫源文件' },
      },
    },
    handler: memoryHeat,
  },
  {
    name: 'memory_edge',
    description: '从「边线」层挑一条快被忘掉的记忆当话题（带心情门），返回本次挑中的内容。',
    parameters: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: '可选，空跑：不写状态、不写 txt' },
        home: { type: 'string', description: '可选，数据目录，默认 ~/.dsh' },
        interval: { type: 'number', description: '可选，间隔毫秒，默认 5.5 天' },
        moodEndpoint: { type: 'string', description: '可选，心情源完整 URL' },
      },
    },
    handler: memoryEdge,
  },
]

/**
 * apply —— DSH 插件挂载点
 *
 * 故意不做任何「猜出来的」注册：不同 DSH 版本的注册签名不一样，编一个只会悄悄坏掉。
 * 宿主接入时在这里把 tools 逐条挂上即可。
 */
function apply(ctx) {
  return {
    name: 'dsh-memory-thermal',
    ctx: ctx || null,
    tools: tools.map((t) => t.name),
    registered: false,
    note: '工具注册部分按 DSH 插件规范二次接入：把 tools[].handler 挂到该版本的工具注册接口上。',
  }
}

module.exports = {
  name: 'dsh-memory-thermal',
  version: '0.1.0',
  description: '记忆冷热 + 艾宾浩斯遗忘 + 边线搭话',
  apply,
  tools,
  memoryHeat,
  memoryEdge,
  // 方便单测直接调
  _runScript: runScript,
  _paths: { MEMORY_INDEX, EDGE_TOPIC },
}
