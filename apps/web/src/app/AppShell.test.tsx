// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { appRoutes } from './router'

const renderRoute = (path: string) => {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
})

describe('AppShell', () => {
  it('marks recipes as the current item in the five-entry bottom navigation', () => {
    renderRoute('/recipes')

    const navigation = screen.getByRole('navigation', { name: '主要导航' })
    const links = within(navigation).getAllByRole('link')

    expect(links).toHaveLength(5)
    expect(links.map((link) => link.textContent)).toEqual([
      '首页',
      '食谱',
      'AI 助手',
      '冰箱',
      '我的',
    ])
    expect(within(navigation).getByRole('link', { name: '食谱' }))
      .toHaveAttribute('aria-current', 'page')
    expect(within(navigation).queryByRole('link', { name: '购物清单' }))
      .not.toBeInTheDocument()
    expect(screen.getByRole('heading', {
      level: 1,
      name: '找一道今天能做好的菜',
    })).toBeInTheDocument()
  })

  it('keeps recipe browsing primary while leaving the AI call entry visible', () => {
    renderRoute('/')

    expect(screen.getByRole('link', { name: '浏览食谱教程' }))
      .toHaveAttribute('data-visual-priority', 'primary')
    expect(screen.getByRole('link', { name: '和小厨 AI 通话' }))
      .toHaveAttribute('data-visual-priority', 'secondary')
    expect(screen.getByRole('link', { name: '打开购物清单' }))
      .toHaveAttribute('href', '/shopping')
  })

  it('provides every planned route through the shared application shell', () => {
    const routeExpectations = [
      ['/recipes/tomato-eggs', '食谱教程'],
      ['/inventory', '看看冰箱里有什么'],
      ['/shopping', '购物清单'],
      ['/assistant', '和小厨 AI 通话'],
      ['/my', '我的厨房'],
      ['/settings/providers', '模型与密钥'],
    ] as const

    for (const [path, heading] of routeExpectations) {
      const view = renderRoute(path)
      expect(screen.getByRole('heading', { level: 1, name: heading }))
        .toBeInTheDocument()
      view.unmount()
    }
  })

  it('does not render a fixed pixel width wider than a 360px viewport', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 360,
    })
    const { container } = renderRoute('/recipes')

    const overflowingElement = [...container.querySelectorAll<HTMLElement>('*')]
      .find((element) => {
        const inlineWidth = element.style.width
        return /^\d+(?:\.\d+)?px$/u.test(inlineWidth)
          && Number.parseFloat(inlineWidth) > window.innerWidth
      })

    expect(overflowingElement).toBeUndefined()
    expect(container.querySelectorAll('[data-media-ratio="4:3"]'))
      .toHaveLength(4)
  })
})
