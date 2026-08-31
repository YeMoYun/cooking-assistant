import type { RecipeDetailMedia } from '@xiaochu/shared'
import { useEffect, useMemo, useState } from 'react'

export type VideoTutorialProps = Readonly<{
  media: readonly RecipeDetailMedia[]
  recipeTitle: string
}>

type Html5Media = Extract<RecipeDetailMedia, { kind: 'html5' }>
type IframeMedia = Extract<RecipeDetailMedia, { kind: 'iframe' }>
type InlineMedia = Html5Media | IframeMedia
type PlayerStatus = 'failed' | 'loading' | 'ready' | 'text-only'

const YOUTUBE_EMBED_PATH = /^\/embed\/[\w-]{6,20}$/u

const readHttpsUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      ? url
      : undefined
  } catch {
    return undefined
  }
}

const isAllowedIframeMedia = (media: IframeMedia): boolean => {
  const url = readHttpsUrl(media.embedUrl)
  if (url === undefined) {
    return false
  }
  if (url.hostname === 'www.youtube-nocookie.com') {
    return YOUTUBE_EMBED_PATH.test(url.pathname)
  }
  return url.hostname === 'player.bilibili.com'
    && url.pathname === '/player.html'
}

const isAllowedInlineMedia = (media: RecipeDetailMedia): media is InlineMedia => {
  if (media.kind === 'html5') {
    // The server owns media classification. Signed/CDN video URLs often have no
    // useful extension, so the client must not guess a different kind from URL text.
    return true
  }
  return media.kind === 'iframe' && isAllowedIframeMedia(media)
}

const isSafeExternalMedia = (
  media: RecipeDetailMedia,
): media is Extract<RecipeDetailMedia, { kind: 'external' }> => (
  media.kind === 'external' && readHttpsUrl(media.url) !== undefined
)

const safePosterUrl = (value: string | null): string | undefined => (
  value !== null && readHttpsUrl(value) !== undefined ? value : undefined
)

export const VideoTutorial = ({ media, recipeTitle }: VideoTutorialProps) => {
  const inlineMedia = useMemo(
    () => {
      const inlineCandidates = media.filter(isAllowedInlineMedia)
      return inlineCandidates.find(
        (item) => item.health.healthStatus !== 'unavailable',
      ) ?? inlineCandidates[0]
    },
    [media],
  )
  const externalMedia = useMemo(
    () => media.filter(isSafeExternalMedia),
    [media],
  )
  const [playerKey, setPlayerKey] = useState(0)
  const [status, setStatus] = useState<PlayerStatus>(() => (
    inlineMedia?.health.healthStatus === 'unavailable' ? 'failed' : 'loading'
  ))

  useEffect(() => {
    setPlayerKey(0)
    setStatus(
      inlineMedia === undefined
      || inlineMedia.health.healthStatus === 'unavailable'
        ? 'failed'
        : 'loading',
    )
  }, [inlineMedia])

  useEffect(() => {
    if (inlineMedia === undefined || status !== 'loading') {
      return undefined
    }
    const timeout = window.setTimeout(() => setStatus('failed'), 12_000)
    return () => window.clearTimeout(timeout)
  }, [inlineMedia, playerKey, status])

  const reload = (): void => {
    setPlayerKey((value) => value + 1)
    setStatus('loading')
  }

  const showPlayer = inlineMedia !== undefined
    && (status === 'loading' || status === 'ready')

  return (
    <section aria-labelledby="video-tutorial-title" className="video-tutorial">
      <header className="video-tutorial__heading">
        <div>
          <h2 id="video-tutorial-title">视频教程</h2>
          <p>视频用于辅助观察，完整文字步骤始终保留在下方。</p>
        </div>
        {inlineMedia !== undefined && status !== 'text-only' && (
          <button
            className="text-button"
            onClick={() => setStatus('text-only')}
            type="button"
          >
            只看文字
          </button>
        )}
      </header>

      {showPlayer && inlineMedia.kind === 'html5' && (
        <div aria-busy={status === 'loading'} className="video-frame">
          <video
            controls
            key={`${inlineMedia.id}-${playerKey}`}
            onError={() => setStatus('failed')}
            onLoadedMetadata={() => setStatus('ready')}
            playsInline
            poster={safePosterUrl(inlineMedia.posterUrl)}
            preload="metadata"
            src={inlineMedia.url}
          >
            当前浏览器无法播放这段视频。
          </video>
          {status === 'loading' && (
            <span className="video-frame__loading" role="status">正在载入视频…</span>
          )}
        </div>
      )}

      {showPlayer && inlineMedia.kind === 'iframe' && (
        <div aria-busy={status === 'loading'} className="video-frame">
          <iframe
            allow="encrypted-media; picture-in-picture"
            allowFullScreen
            key={`${inlineMedia.id}-${playerKey}`}
            loading="lazy"
            onError={() => setStatus('failed')}
            onLoad={() => setStatus('ready')}
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-same-origin allow-scripts allow-presentation"
            src={inlineMedia.embedUrl}
            title={`${recipeTitle}视频教程`}
          />
          {status === 'loading' && (
            <span className="video-frame__loading" role="status">正在载入视频…</span>
          )}
        </div>
      )}

      {status === 'failed' && (
        <div className="video-fallback" role="status">
          <strong>视频暂时无法播放</strong>
          <p>可以直接阅读下方完整原料和步骤，不影响做菜。</p>
          {inlineMedia !== undefined && (
            <button onClick={reload} type="button">重新加载</button>
          )}
        </div>
      )}

      {status === 'text-only' && (
        <div className="video-fallback" role="status">
          <strong>已切换为纯文字教程</strong>
          <p>视频已暂停显示，下方原料和步骤保持完整。</p>
          <button onClick={reload} type="button">重新显示视频</button>
        </div>
      )}

      {externalMedia.length > 0 && (
        <div className="external-media-links">
          <strong>站外视频</strong>
          {externalMedia.map((item) => (
            <a
              href={item.url}
              key={item.id}
              referrerPolicy="no-referrer"
              rel="noopener noreferrer"
              target="_blank"
            >
              在新窗口打开 {item.provider} 视频
            </a>
          ))}
        </div>
      )}
    </section>
  )
}
