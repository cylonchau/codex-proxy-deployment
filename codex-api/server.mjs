// Codex CLI -> OpenAI 兼容 API。每个请求起一个 `codex exec --json`,把事件流转成 chat.completion(.chunk)。
// - 模型列表读 Codex 自己缓存的 models_cache.json(账号实际可用的模型),推理强度读请求里的 reasoning_effort
// - 分用户/会话:按 Open WebUI 转发的 X-OpenWebUI-User-Id / X-OpenWebUI-Chat-Id 给每个会话独立工作目录,
//   并把 chat -> codex thread 的对应关系持久化,下一轮用 `codex exec resume` 续同一个 thread
// 无依赖,仅用 Node 内置模块。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'

const env = process.env
const csv = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean)
const PORT = Number(env.PORT || 8000)
const API_KEY = env.API_KEY || ''
const WORKROOT = env.CODEX_WORKDIR || '/workspace'
const CODEX_HOME = env.CODEX_HOME || '/root/.codex'
const SANDBOX = env.CODEX_SANDBOX || 'read-only' // read-only | workspace-write | danger-full-access
const DEFAULT_MODEL = env.CODEX_DEFAULT_MODEL || 'codex' // 'codex' = 不传 -m,用 CLI 自己的默认模型
const EXTRA_MODELS = csv(env.CODEX_MODELS)
const TIMEOUT_MS = Number(env.CODEX_TIMEOUT_MS || 600000)
const MAX_CONCURRENCY = Number(env.MAX_CONCURRENCY || 4)
const QUEUE_TIMEOUT_MS = Number(env.QUEUE_TIMEOUT_MS || 300000)
const RESUME = (env.CODEX_RESUME || 'true') !== 'false'
const SESSION_TTL_MS = Number(env.SESSION_TTL_DAYS || 30) * 86400000
const EXTRA_ARGS = (env.CODEX_EXTRA_ARGS || '').split(/\s+/).filter(Boolean)
const ALL_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const USAGE_MODEL = 'codex-usage' // 伪模型:选中后发任意消息,返回账号额度,不调用 codex、不耗额度

// 子进程不能拿到网关密钥
const { API_KEY: _hidden, ...CHILD_ENV } = env

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const err = (res, code, message, type = 'invalid_request_error') => json(res, code, { error: { message, type, code: null } })
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16)
const isSys = (m) => m.role === 'system' || m.role === 'developer'

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 20 * 1024 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const partText = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (p?.type === 'text' || p?.type === 'input_text' ? p.text : p?.type?.includes('image') ? '[image omitted]' : ''))
    .filter(Boolean)
    .join('\n')
}

// ---------- 模型 ----------
const hasAuth = () => fs.existsSync(path.join(CODEX_HOME, 'auth.json'))
const LOGIN_HINT = 'Codex 还没有登录。请在服务器上运行 ./ops.sh login 完成登录。'
const friendlyError = (message) => {
  if (!hasAuth()) return LOGIN_HINT
  if (/unauthorized/i.test(message)) return `Codex 登录已失效,请在服务器上重新运行 ./ops.sh login。(${String(message).slice(0, 160)})`
  return message
}

const mapModels = (arr) =>
  arr
    .filter((m) => m && m.slug && m.visibility === 'list')
    .map((m) => ({
      id: m.slug,
      name: m.display_name || m.slug,
      efforts: (m.supported_reasoning_levels || []).map((r) => (typeof r === 'string' ? r : r?.effort)).filter(Boolean),
    }))

let modelCache = { mtime: 0, list: [] }
// `codex debug models` 的结果。只有登录后它才是账号实际可用的模型;未登录时它返回的是内置的通用列表,不能用。
let catalog = null // { at, list }
const loadCodexModels = () => {
  if (catalog && hasAuth()) return catalog.list
  try {
    const f = path.join(CODEX_HOME, 'models_cache.json')
    const st = fs.statSync(f)
    if (st.mtimeMs !== modelCache.mtime) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      modelCache = { mtime: st.mtimeMs, list: mapModels(Array.isArray(j) ? j : j.models || []) }
    }
  } catch {
    /* 缓存还没生成:只列 codex */
  }
  return modelCache.list
}

let modelsRefreshing = null
const refreshModels = () => {
  if (modelsRefreshing) return modelsRefreshing
  modelsRefreshing = new Promise((resolve) => {
    execFile('codex', ['debug', 'models'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000, env: CHILD_ENV }, (e, stdout) => {
      try {
        if (!e) {
          const j = JSON.parse(stdout)
          const list = mapModels(Array.isArray(j) ? j : j.models || [])
          if (list.length) catalog = { at: Date.now(), list }
        }
      } catch {
        /* 保持旧结果 */
      }
      modelsRefreshing = null
      resolve()
    })
  })
  return modelsRefreshing
}

const listModels = () => {
  const out = []
  const seen = new Set()
  const push = (id, name, efforts) => {
    if (seen.has(id)) return
    seen.add(id)
    out.push({ id, object: 'model', created: 0, owned_by: 'codex', name: name || id, ...(efforts?.length ? { reasoning_efforts: efforts } : {}) })
  }
  for (const m of loadCodexModels()) push(m.id, m.name, m.efforts)
  for (const id of EXTRA_MODELS) push(id)
  push(DEFAULT_MODEL, DEFAULT_MODEL === 'codex' ? 'Codex (CLI default model)' : undefined)
  push(USAGE_MODEL, 'Codex quota (send any message)')
  return out
}

const pickEffort = (body, model) => {
  const raw = body.reasoning_effort ?? body.reasoning?.effort
  if (typeof raw !== 'string' || !raw) return null
  const v = raw.toLowerCase()
  const m = loadCodexModels().find((x) => x.id === model)
  if (m?.efforts.length) return m.efforts.includes(v) ? v : null
  return ALL_EFFORTS.includes(v) ? v : null
}

// ---------- 用户 / 会话 ----------
const safeId = (v, fallback) => {
  const s = String(v ?? '').trim()
  if (!s) return fallback
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(s) ? s : sha(s) // 不允许 . .. 和路径字符
}
const oneLine = (s) => String(s || '').replace(/[\r\n\t]+/g, ' ').slice(0, 80)

const identify = (req, body) => {
  const h = req.headers
  const rawUser = h['x-openwebui-user-id'] || body.user || ''
  return {
    userId: safeId(rawUser, 'anonymous'),
    label: oneLine(h['x-openwebui-user-email'] || h['x-openwebui-user-name'] || rawUser || 'anonymous'),
    chatId: h['x-openwebui-chat-id'] ? safeId(h['x-openwebui-chat-id'], '') : '',
  }
}

const STATE_DIR = path.join(WORKROOT, '.bridge')
const STATE_FILE = path.join(STATE_DIR, 'sessions.json')
let sessions = {}
try {
  sessions = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
} catch {
  /* 首次启动 */
}
let saveTimer = null
const saveSessions = () => {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const cutoff = Date.now() - SESSION_TTL_MS
    for (const [k, v] of Object.entries(sessions)) if (!v.updated || v.updated < cutoff) delete sessions[k]
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(sessions))
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE)
    } catch (e) {
      console.error('save sessions failed:', e.message)
    }
  }, 500)
}

// 同一个会话串行;全局并发用队列而不是直接 429
const chatTails = new Map()
const withChatLock = async (key, fn) => {
  const prev = chatTails.get(key) || Promise.resolve()
  let release
  const mine = new Promise((r) => (release = r))
  const tail = prev.then(() => mine)
  chatTails.set(key, tail)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (chatTails.get(key) === tail) chatTails.delete(key)
  }
}

let active = 0
let waiters = []
const acquireSlot = () => {
  let waiter
  const promise = new Promise((resolve, reject) => {
    const grant = () => {
      active++
      resolve(() => {
        active--
        const next = waiters.shift()
        if (next) {
          clearTimeout(next.timer)
          next.grant()
        }
      })
    }
    if (active < MAX_CONCURRENCY) return grant()
    waiter = { grant, timer: setTimeout(() => {
      waiters = waiters.filter((x) => x !== waiter)
      reject(new Error('queue timeout'))
    }, QUEUE_TIMEOUT_MS) }
    waiters.push(waiter)
  })
  const cancel = () => {
    if (!waiter) return
    clearTimeout(waiter.timer)
    waiters = waiters.filter((x) => x !== waiter)
  }
  return { promise, cancel }
}

// ---------- prompt ----------
// 新会话:把整段对话拍平成一个 prompt
const buildPrompt = (messages) => {
  const system = messages.filter(isSys).map((m) => partText(m.content)).filter(Boolean)
  const turns = messages.filter((m) => !isSys(m))
  const last = turns.length ? turns[turns.length - 1] : null
  const parts = []
  if (system.length) parts.push(`<system>\n${system.join('\n\n')}\n</system>`)
  if (turns.length > 1) {
    const hist = turns.slice(0, -1).map((m) => `[${m.role}]\n${partText(m.content)}`).join('\n\n')
    parts.push(`<conversation_so_far>\n${hist}\n</conversation_so_far>`)
  }
  parts.push(last ? partText(last.content) : '')
  return parts.join('\n\n')
}

// ---------- codex ----------
const runCodex = ({ args, prompt, cwd, onEvent }) => {
  const child = spawn('codex', args, { cwd, env: CHILD_ENV, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  let stderr = ''
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        onEvent(JSON.parse(line))
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  })
  child.stderr.on('data', (d) => {
    stderr = (stderr + d.toString('utf8')).slice(-4000)
  })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)
  const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stderr: String(e) })
    })
  })
  return { done, kill: () => child.kill('SIGKILL') }
}

// ---------- 账号额度 ----------
// 优先实时查 ChatGPT 的用量接口(Codex 自己的 /status 用的就是它);失败则退回 Codex 写在会话记录里的最近一次快照。
const normWindow = (minutes, usedPercent, resetsAt, resetsIn) =>
  minutes == null && usedPercent == null
    ? null
    : { window_minutes: minutes, used_percent: usedPercent, resets_at: resetsAt ?? null, resets_in_seconds: resetsIn ?? (resetsAt ? Math.max(0, resetsAt - Date.now() / 1000) : null) }

const fetchLiveUsage = async () => {
  const auth = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'auth.json'), 'utf8'))
  const t = auth.tokens || {}
  if (!t.access_token) throw new Error('当前不是 ChatGPT 登录,没有额度接口')
  const headers = { Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'codex-cli' }
  if (t.account_id) headers['ChatGPT-Account-Id'] = t.account_id
  const r = await fetch('https://chatgpt.com/backend-api/wham/usage', { headers, signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`额度接口返回 HTTP ${r.status}`)
  const j = await r.json()
  const rl = j.rate_limit || {}
  const w = (x) => (x ? normWindow(Math.round((x.limit_window_seconds || 0) / 60), x.used_percent, x.reset_at, x.reset_after_seconds) : null)
  return {
    source: 'live',
    plan: j.plan_type || null,
    limit_reached: !!rl.limit_reached,
    primary: w(rl.primary_window),
    secondary: w(rl.secondary_window),
    credits: j.credits ? { has_credits: !!j.credits.has_credits, unlimited: !!j.credits.unlimited, balance: j.credits.balance ?? null } : null,
  }
}

const latestRollouts = (limit = 5) => {
  const ls = (d) => {
    try {
      return fs.readdirSync(d).sort().reverse()
    } catch {
      return []
    }
  }
  const root = path.join(CODEX_HOME, 'sessions')
  const out = []
  for (const y of ls(root)) for (const m of ls(path.join(root, y))) for (const d of ls(path.join(root, y, m))) {
    const dir = path.join(root, y, m, d)
    for (const f of ls(dir)) if (f.endsWith('.jsonl')) out.push(path.join(dir, f))
    if (out.length >= limit) return out
  }
  return out
}

const snapshotUsage = () => {
  for (const f of latestRollouts()) {
    try {
      const st = fs.statSync(f)
      const fd = fs.openSync(f, 'r')
      const len = Math.min(st.size, 262144)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, st.size - len)
      fs.closeSync(fd)
      const lines = buf.toString('utf8').split('\n').filter((l) => l.includes('"token_count"') && l.includes('"rate_limits"'))
      for (let i = lines.length - 1; i >= 0; i--) {
        let ev
        try {
          ev = JSON.parse(lines[i])
        } catch {
          continue
        }
        const rl = ev?.payload?.rate_limits
        if (!rl) continue
        const w = (x) => (x ? normWindow(x.window_minutes, x.used_percent, x.resets_at) : null)
        return {
          source: 'snapshot',
          as_of: ev.timestamp,
          plan: rl.plan_type || null,
          limit_reached: !!rl.rate_limit_reached_type,
          primary: w(rl.primary),
          secondary: w(rl.secondary),
          credits: rl.credits ? { has_credits: !!rl.credits.has_credits, unlimited: !!rl.credits.unlimited, balance: rl.credits.balance ?? null } : null,
        }
      }
    } catch {
      /* 试下一个文件 */
    }
  }
  return null
}

let usageCache = { at: 0, data: null }
const getUsage = async () => {
  if (!hasAuth()) throw new Error(LOGIN_HINT)
  if (usageCache.data && Date.now() - usageCache.at < 30000) return usageCache.data
  let data
  try {
    data = await fetchLiveUsage()
  } catch (e) {
    data = snapshotUsage()
    if (data) data.live_error = String(e.message || e)
    else throw new Error(`查不到额度:${e.message || e}`)
  }
  usageCache = { at: Date.now(), data }
  return data
}

const fmtDur = (sec) => {
  if (sec == null) return '?'
  const s = Math.max(0, Math.round(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}
const winLabel = (min) => (!min ? '窗口 / window' : min === 10080 ? '每周 / weekly' : min % 1440 === 0 ? `${min / 1440} 天 / ${min / 1440}-day` : `${min / 60} 小时 / ${min / 60}-hour`)

const usageText = (u) => {
  const lines = [`**Codex 额度 / quota** · ${u.plan || '?'} 套餐${u.limit_reached ? ' · ⚠️ 已达上限 / limit reached' : ''}`, '']
  for (const w of [u.primary, u.secondary]) {
    if (w) lines.push(`- ${winLabel(w.window_minutes)}:已用 / used **${w.used_percent}%** · ${fmtDur(w.resets_in_seconds)} 后重置 / resets in`)
  }
  if (u.credits) lines.push(`- 额外点数 / credits:${u.credits.unlimited ? '无限 / unlimited' : u.credits.has_credits ? u.credits.balance : '无 / none'}`)
  lines.push('', u.source === 'live' ? '_数据:实时 / live_' : `_数据:快照 / snapshot as of ${u.as_of}(实时查询失败:${u.live_error})_`)
  lines.push('_这是 ChatGPT 账号的总额度,所有用户共用。 / Account-wide quota, shared by all users._')
  return lines.join('\n')
}

const respondText = (res, body, text) => {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const model = body.model
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const c = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    res.write(c({ role: 'assistant', content: '' }))
    res.write(c({ content: text }))
    res.write(c({}, 'stop'))
    return res.end('data: [DONE]\n\n')
  }
  json(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
}

const usageChat = async (res, body) => {
  const last = [...body.messages].reverse().find((m) => m.role === 'user')
  // Open WebUI 的标题/标签等后台任务都以 "### Task:" 开头,别把整段额度当标题
  if (/^\s*###\s*Task:/i.test(partText(last?.content))) return respondText(res, body, 'Codex quota')
  try {
    return respondText(res, body, usageText(await getUsage()))
  } catch (e) {
    return respondText(res, body, `⚠️ ${e.message || e}`)
  }
}

const chat = async (req, res) => {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (e) {
    return err(res, 400, `invalid JSON body: ${e.message}`)
  }
  if (!Array.isArray(body.messages) || !body.messages.length) return err(res, 400, 'messages is required')
  if (body.model === USAGE_MODEL) return await usageChat(res, body)

  const who = identify(req, body)
  const model = body.model || DEFAULT_MODEL
  const effort = pickEffort(body, model)
  const stream = body.stream === true
  const wantUsage = stream && body.stream_options?.include_usage === true
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  const msgs = body.messages
  const turns = msgs.filter((m) => !isSys(m))
  const lastTurn = turns[turns.length - 1]
  const sysHash = sha(msgs.filter(isSys).map((m) => partText(m.content)).join('\n\n'))
  const firstHash = turns.length ? sha(norm(partText(turns[0].content))) : ''
  const key = RESUME && who.chatId ? `${who.userId}/${who.chatId}` : ''

  const userDir = path.join(WORKROOT, 'users', who.userId)
  const chatDir = who.chatId ? path.join(userDir, 'chats', who.chatId) : path.join(userDir, 'adhoc')
  try {
    fs.mkdirSync(chatDir, { recursive: true })
  } catch (e) {
    return err(res, 500, `cannot create workspace: ${e.message}`, 'server_error')
  }

  let clientGone = false
  let current = null
  let slotWait = null
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true
      current?.kill()
      slotWait?.cancel()
    }
  })

  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  let sentRole = false
  const send = (delta) => {
    if (!stream || clientGone) return
    if (!sentRole) {
      res.write(chunk({ role: 'assistant', content: '' }))
      sentRole = true
    }
    res.write(chunk(delta))
  }
  if (stream) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })

  // 一次执行的可变状态
  let usage = null
  let failure = ''
  let texts = []
  let reasoning = []
  let threadId = ''
  let queueMs = 0
  let mode = 'adhoc'
  let ok = false
  const t0 = Date.now()

  const attempt = async (m, resumeId) => {
    usage = null
    failure = ''
    texts = []
    reasoning = []
    threadId = ''
    const base = ['--json', '--skip-git-repo-check', '--disable', 'memories']
    if (model && model !== 'codex') base.push('-m', model)
    if (effort) base.push('-c', `model_reasoning_effort="${effort}"`)
    const args =
      m === 'resume'
        ? ['exec', 'resume', ...base, '-c', `sandbox_mode="${SANDBOX}"`, ...EXTRA_ARGS, resumeId, '-']
        : ['exec', ...base, '-C', chatDir, '-s', SANDBOX, ...(m === 'new' ? [] : ['--ephemeral']), ...EXTRA_ARGS, '-']
    const prompt = m === 'resume' ? partText(lastTurn.content) : buildPrompt(msgs)

    slotWait = acquireSlot()
    const tw = Date.now()
    let release
    try {
      release = await slotWait.promise
    } catch (e) {
      failure = `服务繁忙,排队超过 ${Math.round(QUEUE_TIMEOUT_MS / 1000)} 秒`
      return { code: -2, stderr: '' }
    } finally {
      queueMs += Date.now() - tw
      slotWait = null
    }
    if (clientGone) {
      release()
      return { code: -3, stderr: '' }
    }
    try {
      current = runCodex({
        args,
        prompt,
        cwd: chatDir,
        onEvent: (ev) => {
          if (ev.type === 'thread.started' && ev.thread_id) threadId = ev.thread_id
          else if (ev.type === 'turn.completed' && ev.usage) usage = ev.usage
          else if (ev.type === 'turn.failed') failure = ev.error?.message || 'turn failed'
          else if (ev.type === 'error') failure = ev.message || failure || 'codex error'
          else if (ev.type === 'item.completed') {
            const it = ev.item || {}
            if (it.type === 'agent_message' && it.text) {
              const sep = texts.length ? '\n\n' : ''
              texts.push(it.text)
              send({ content: sep + it.text })
            } else if (it.type === 'reasoning' && it.text) {
              reasoning.push(it.text)
              send({ reasoning_content: it.text + '\n\n' })
            }
          }
        },
      })
      return await current.done
    } finally {
      current = null
      release()
    }
  }

  const exec = async () => {
    // 决定:续会话 / 新会话(并记录) / 旁路请求(标题、标签等,不污染会话)
    let resumeId = ''
    mode = key ? 'new' : 'adhoc'
    const sess = key ? sessions[key] : null
    if (sess) {
      const prev = turns[turns.length - 2]
      if (
        sess.first === firstHash &&
        sess.sys === sysHash &&
        turns.length === sess.count + 1 &&
        lastTurn?.role === 'user' &&
        prev?.role === 'assistant' &&
        norm(partText(prev.content)) === sess.last
      ) {
        mode = 'resume'
        resumeId = sess.thread
      } else if (turns.length === 1 && sess.first !== firstHash) {
        mode = 'side'
      }
    }

    let r = await attempt(mode, resumeId)
    const failed = () => !texts.length && (failure || r.code !== 0)
    if (mode === 'resume' && failed() && !clientGone) {
      console.error(`[codex] resume failed for ${key}: ${failure || r.stderr.trim()} -> falling back to a new thread`)
      delete sessions[key]
      mode = 'new'
      r = await attempt('new')
    }

    ok = !failed()
    if (ok && key && (mode === 'new' || mode === 'resume')) {
      const thread = mode === 'resume' ? resumeId : threadId
      if (thread) {
        sessions[key] = { thread, count: turns.length + 1, last: norm(texts.join('\n\n')), first: firstHash, sys: sysHash, updated: Date.now() }
        saveSessions()
      }
    }
    return r
  }

  let r
  try {
    r = key ? await withChatLock(key, exec) : await exec()
  } catch (e) {
    console.error(e)
    r = { code: -1, stderr: String(e.message || e) }
    failure = failure || r.stderr
  }

  const content = texts.join('\n\n')
  console.log(
    JSON.stringify({
      t: new Date().toISOString(), user: who.label, uid: who.userId, chat: who.chatId || null, model, effort, mode,
      queue_ms: queueMs, ms: Date.now() - t0, in: usage?.input_tokens ?? null, out: usage?.output_tokens ?? null, ok, aborted: clientGone || undefined,
    }),
  )
  if (clientGone) return

  const u = usage
    ? { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0, total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) }
    : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

  if (!ok) {
    const message = friendlyError(failure || r?.stderr?.trim() || `codex exited with code ${r?.code}`)
    console.error(`[codex] failed: ${message}`)
    if (stream) {
      send({ content: `⚠️ codex 出错:${message}` })
      res.write(chunk({}, 'stop'))
      res.end('data: [DONE]\n\n')
      return
    }
    return err(res, r?.code === -2 ? 429 : 502, message, r?.code === -2 ? 'rate_limit_error' : 'upstream_error')
  }

  if (stream) {
    res.write(chunk({}, 'stop'))
    if (wantUsage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: u })}\n\n`)
    res.end('data: [DONE]\n\n')
    return
  }
  const message = { role: 'assistant', content }
  if (reasoning.length) message.reasoning_content = reasoning.join('\n\n')
  json(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: 'stop' }], usage: u })
}

// 收到停止信号(compose up / docker stop / 重启)时,先把进行中的请求跑完再退出,不再把流式回复拦腰切断
const DRAIN_MS = Number(env.DRAIN_MS || 120000)
let inflight = 0
let draining = false

const server = http.createServer(async (req, res) => {
  inflight++
  res.on('close', () => inflight--)
  if (draining) res.setHeader('connection', 'close')
  const p = (req.url || '').split('?')[0]
  if (p === '/health' || p === '/healthz') return json(res, 200, { ok: true, running: active, queued: waiters.length, sessions: Object.keys(sessions).length })
  if (API_KEY) {
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (got !== API_KEY) return err(res, 401, 'invalid api key', 'authentication_error')
  }
  try {
    if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
      // 登录后每小时最多刷新一次模型表(不是对话请求,不耗额度)
      if (hasAuth() && (!catalog || Date.now() - catalog.at > 3600000)) await refreshModels()
      return json(res, 200, { object: 'list', data: listModels() })
    }
    if (req.method === 'GET' && (p === '/v1/usage' || p === '/usage')) {
      try {
        const u = await getUsage()
        return json(res, 200, { ...u, text: usageText(u) })
      } catch (e) {
        return err(res, 502, String(e.message || e), 'upstream_error')
      }
    }
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) return await chat(req, res)
    return err(res, 404, `not found: ${req.method} ${p}`)
  } catch (e) {
    console.error(e)
    if (!res.headersSent) err(res, 500, String(e.message || e), 'server_error')
    else res.end()
  }
})

const drain = (sig) => {
  if (draining) return
  draining = true
  console.log(`${sig}: draining ${inflight} in-flight request(s), up to ${Math.round(DRAIN_MS / 1000)}s`)
  server.close()
  server.closeIdleConnections?.()
  const poll = setInterval(() => {
    server.closeIdleConnections?.()
    if (inflight === 0) {
      clearInterval(poll)
      console.log('drained, exiting')
      process.exit(0)
    }
  }, 300)
  setTimeout(() => {
    console.log(`drain timeout, exiting with ${inflight} request(s) still running`)
    process.exit(0)
  }, DRAIN_MS)
}
process.on('SIGTERM', () => drain('SIGTERM'))
process.on('SIGINT', () => drain('SIGINT'))

// ---------- 定期清理 ----------
// Codex 给每个会话落一份记录文件,聊天还会有独立工作目录,都不会自己消失。
// 超过 SESSION_TTL_DAYS 没动过的就删;仍在会话映射里且未过期的聊天目录不动。过期后再续聊只会退回"新会话+完整历史",不会出错。
const prune = () => {
  try {
    const cutoff = Date.now() - SESSION_TTL_MS
    let files = 0
    let dirs = 0
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) {
          walk(p)
          if (!fs.readdirSync(p).length) fs.rmdirSync(p)
        } else if (e.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs < cutoff) {
          fs.unlinkSync(p)
          files++
        }
      }
    }
    try {
      walk(path.join(CODEX_HOME, 'sessions'))
    } catch {
      /* 还没有会话记录 */
    }
    const active = new Set(Object.entries(sessions).filter(([, v]) => v.updated >= cutoff).map(([k]) => k))
    const usersRoot = path.join(WORKROOT, 'users')
    try {
      for (const u of fs.readdirSync(usersRoot)) {
        const chats = path.join(usersRoot, u, 'chats')
        let names = []
        try {
          names = fs.readdirSync(chats)
        } catch {
          continue
        }
        for (const c of names) {
          const p = path.join(chats, c)
          if (!active.has(`${u}/${c}`) && fs.statSync(p).mtimeMs < cutoff) {
            fs.rmSync(p, { recursive: true, force: true })
            dirs++
          }
        }
      }
    } catch {
      /* 还没有用户目录 */
    }
    saveSessions()
    if (files || dirs) console.log(`[prune] removed ${files} session record(s) and ${dirs} chat workspace(s) idle for over ${SESSION_TTL_MS / 86400000} day(s)`)
  } catch (e) {
    console.error('[prune] failed:', e.message)
  }
}
setTimeout(() => {
  prune()
  setInterval(prune, Number(env.PRUNE_INTERVAL_HOURS || 6) * 3600000).unref()
}, Number(env.PRUNE_FIRST_DELAY_MS || 60000)).unref()

server.listen(PORT, '0.0.0.0', () =>
  console.log(`codex-api listening on :${PORT}, sandbox=${SANDBOX}, workroot=${WORKROOT}, resume=${RESUME}, models=${listModels().length}`),
)
