import type { ModelOptions } from './types'

const endpoints = { responses: '/responses', claude: '/messages', chat: '/chat/completions' }

export function connectionInfo(options: ModelOptions) {
  try {
    const url = new URL(options.base_url.trim())
    if (url.username || url.password || url.search || url.hash) return { endpoint: '', deepseek: false, hint: '地址不能包含凭证、查询参数或片段。' }
    let path = url.pathname.replace(/\/+$/, '')
    for (const [protocol, suffix] of Object.entries(endpoints)) {
      if (!path.endsWith(suffix)) continue
      if (protocol !== options.provider) return { endpoint: '', deepseek: url.hostname === 'api.deepseek.com', hint: '完整接口路径与接口类型不一致，请修改接口类型或使用基础地址。' }
      path = path.slice(0, -suffix.length)
      break
    }
    url.pathname = path + endpoints[options.provider]
    return { endpoint: url.toString(), deepseek: url.hostname === 'api.deepseek.com', hint: null }
  } catch { return { endpoint: '', deepseek: false, hint: '请填写有效的 HTTPS 服务地址。' } }
}

export function changeProtocol(options: ModelOptions, provider: ModelOptions['provider']): ModelOptions {
  let baseUrl = options.base_url
  try {
    const url = new URL(baseUrl)
    if (['api.openai.com', 'api.anthropic.com'].includes(url.hostname)) baseUrl = provider === 'claude' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'
    else {
      let path = url.pathname.replace(/\/+$/, '')
      for (const suffix of Object.values(endpoints)) if (path.endsWith(suffix)) { path = path.slice(0, -suffix.length); break }
      url.pathname = path; baseUrl = url.toString().replace(/\/+$/, '')
    }
  } catch { /* 不覆盖用户正在输入的不完整地址。 */ }
  return { ...options, provider, base_url: baseUrl }
}
