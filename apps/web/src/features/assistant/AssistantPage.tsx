import { providerProfileListSchema, type ProviderProfile } from '@xiaochu/shared'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiClient } from '../../lib/api-client'
import { TurnController } from './turn-controller'
import { listenOnce } from './speech-recognition'
import { stopSpeaking } from './speech-synthesis'
import '../inventory/kitchen.css'

type Line = { role: 'user' | 'assistant'; text: string }

export const AssistantPage = () => {
  const [providers, setProviders] = useState<ProviderProfile[]>([])
  const [providerId, setProviderId] = useState('')
  const [session, setSession] = useState<string>()
  const [text, setText] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [state, setState] = useState('idle')
  const [error, setError] = useState<string>()
  const controller = useRef<TurnController | undefined>(undefined)
  useEffect(() => { void apiClient.request<unknown>('/api/providers', { method: 'GET', signal: new AbortController().signal }).then((value) => { const found = providerProfileListSchema.parse(value).filter((p) => p.kind === 'text' && p.enabled); setProviders(found); setProviderId(found[0]?.id ?? '') }).catch(() => setError('Unable to load model settings.')) }, [])
  const ensure = async (): Promise<string> => { if (session !== undefined) return session; if (!providerId) throw new Error('Configure a text model first.'); const created = await apiClient.request<{ id: string }>('/api/voice/sessions', { method: 'POST', body: { providerId, context: { includeInventory: false, includeShopping: false } }, signal: new AbortController().signal }); setSession(created.id); return created.id }
  const send = async (value = text): Promise<void> => { if (!value.trim()) return; try { const id = await ensure(); setLines((current) => [...current, { role: 'user', text: value }, { role: 'assistant', text: '' }]); setText(''); const next = new TurnController(id, (delta) => setLines((current) => current.map((line, index) => index === current.length - 1 ? { ...line, text: line.text + delta } : line)), setState); controller.current = next; await next.start(value) } catch (caught) { setError(caught instanceof Error ? caught.message : 'The assistant is unavailable.'); setState('error') } }
  return <section className="page kitchen-page"><header className="page-heading"><p className="eyebrow">AI assistant</p><h1>Ask when cooking gets stuck</h1><p>Recipe tutorials remain on recipe pages. This conversation starts with no recipe, inventory, or shopping-list context.</p></header><section className="kitchen-panel"><label>Text model<select onChange={(event) => { setProviderId(event.target.value); setSession(undefined) }} value={providerId}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.modelId}</option>)}</select></label>{providers.length === 0 && <p>No text model is available. <Link to="/settings/providers">Configure DeepSeek or Qwen</Link>.</p>}<div className="assistant-transcript">{lines.map((line, index) => <p className={`assistant-line assistant-line--${line.role}`} key={index}>{line.text || '…'}</p>)}</div>{error !== undefined && <p className="form-error">{error}</p>}<textarea aria-label="Cooking question" onChange={(event) => setText(event.target.value)} placeholder="Ask a precise cooking question…" value={text} /><div className="action-row"><button onClick={() => { controller.current?.cancel(); stopSpeaking(); listenOnce((spoken) => { setText(spoken); void send(spoken) }, setError) }} type="button">Interrupt and speak</button><button disabled={state === 'thinking' || !text.trim()} onClick={() => { void send() }} type="button">{state === 'thinking' ? 'Thinking…' : 'Send'}</button></div></section></section>
}
