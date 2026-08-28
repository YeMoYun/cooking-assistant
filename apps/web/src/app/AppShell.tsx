import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'

type TabIconName = 'assistant' | 'home' | 'inventory' | 'my' | 'recipes'

type NavigationItem = {
  readonly icon: TabIconName
  readonly label: string
  readonly to: string
}

const navigationItems: readonly NavigationItem[] = [
  { icon: 'home', label: '首页', to: '/' },
  { icon: 'recipes', label: '食谱', to: '/recipes' },
  { icon: 'assistant', label: 'AI 助手', to: '/assistant' },
  { icon: 'inventory', label: '冰箱', to: '/inventory' },
  { icon: 'my', label: '我的', to: '/my' },
]

const TabIcon = ({ name }: { readonly name: TabIconName }) => {
  const paths: Readonly<Record<TabIconName, React.ReactNode>> = {
    assistant: (
      <>
        <rect x="7" y="3" width="10" height="13" rx="5" />
        <path d="M4.5 11.5a7.5 7.5 0 0 0 15 0M12 19v3M8.5 22h7" />
      </>
    ),
    home: (
      <>
        <path d="m3 11 9-8 9 8" />
        <path d="M5.5 9.5V21h13V9.5M9.5 21v-6h5v6" />
      </>
    ),
    inventory: (
      <>
        <rect x="5" y="2.5" width="14" height="19" rx="2" />
        <path d="M5 10h14M9 6.5v1M9 13.5v2" />
      </>
    ),
    my: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
      </>
    ),
    recipes: (
      <>
        <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H11v18H6.5A2.5 2.5 0 0 0 4 22z" />
        <path d="M20 4.5A2.5 2.5 0 0 0 17.5 2H13v18h4.5A2.5 2.5 0 0 1 20 22z" />
      </>
    ),
  }

  return (
    <svg
      aria-hidden="true"
      className="tab-icon"
      fill="none"
      viewBox="0 0 24 24"
    >
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        {paths[name]}
      </g>
    </svg>
  )
}

type LocalServiceStatus = 'available' | 'checking' | 'unavailable'

const LocalServiceNotice = () => {
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [status, setStatus] = useState<LocalServiceStatus>('checking')

  useEffect(() => {
    if (
      !('serviceWorker' in navigator)
      || navigator.serviceWorker.controller === null
    ) {
      setStatus('available')
      return undefined
    }

    const abortController = new AbortController()
    setStatus('checking')
    void fetch('/api/health', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: abortController.signal,
    }).then((response) => {
      if (!response.ok) {
        throw new Error('Local service health check failed')
      }
      setStatus('available')
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setStatus('unavailable')
      }
    })

    return () => abortController.abort()
  }, [retryAttempt])

  if (status !== 'unavailable') {
    return null
  }

  return (
    <aside aria-live="assertive" className="local-service-notice" role="alert">
      <div className="local-service-notice__copy">
        <strong>本地服务未启动</strong>
        <span>
          当前只加载了应用外壳。请在项目目录运行
          {' '}
          <code>npm run start -w @xiaochu/server</code>
          {' '}
          后重试；食谱与 AI 数据需要本地服务。
        </span>
      </div>
      <button
        className="local-service-notice__retry"
        onClick={() => setRetryAttempt((attempt) => attempt + 1)}
        type="button"
      >
        重试
      </button>
    </aside>
  )
}

export const AppShell = () => (
  <div className="app-shell">
    <header className="app-header">
      <div className="app-header__inner">
        <Link aria-label="回到小厨首页" className="brand" to="/">
          <span aria-hidden="true" className="brand__mark">厨</span>
          <span className="brand__copy">
            <strong>小厨</strong>
            <small>把今天这顿做得好吃</small>
          </span>
        </Link>
      </div>
    </header>

    <LocalServiceNotice />

    <main className="app-main" id="main-content">
      <Outlet />
    </main>

    <nav aria-label="主要导航" className="bottom-navigation">
      <div className="bottom-navigation__inner">
        {navigationItems.map((item) => (
          <NavLink
            className={({ isActive }) => (
              `bottom-navigation__link${isActive ? ' is-active' : ''}`
            )}
            end={item.to === '/'}
            key={item.to}
            to={item.to}
          >
            <TabIcon name={item.icon} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  </div>
)
