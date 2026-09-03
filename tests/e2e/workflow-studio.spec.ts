import { expect, test } from '@playwright/test'

const graph = {
  current_version: 7,
  nodes: [
    { id: 'observe', label: 'Observe', x: 120, y: 120, metadata: { wf_op: 'noop', wf_start: true } },
    { id: 'act', label: 'Act', x: 360, y: 120, metadata: { wf_op: 'noop' } },
    { id: 'done', label: 'Done', x: 600, y: 120, metadata: { wf_op: 'noop', wf_terminal: true } },
  ],
  edges: [{ id: 'edge-1', source_ids: ['observe'], target_ids: ['act'], metadata: { wf_predicate: 'ready' } }],
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith('/graph')) return route.fulfill({ json: graph })
    if (url.pathname.endsWith('/catalog/ops')) return route.fulfill({ json: [{ op: 'noop', label: 'No-op' }] })
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: { can_undo: true, can_redo: false } })
    if (url.pathname.endsWith('/me')) return route.fulfill({ json: { email: 'designer@example.test' } })
    if (request.method() === 'POST' || request.method() === 'DELETE') return route.fulfill({ json: { version: 8 } })
    return route.fulfill({ status: 404, json: { detail: 'mock route missing' } })
  })
})

test('loads graph, edits selection, persists layout, and restores viewport', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Workflow Studio' })).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  await expect(page.locator('.subtle').first()).toHaveText(/3 nodes.*1 edges.*1 terminals.*1 routed/)
  await page.screenshot({ path: 'docs/screenshots/workflow-studio-desktop.png', fullPage: true })
  await page.locator('.react-flow__node').first().click()
  await expect(page.getByRole('heading', { name: 'Node' })).toBeVisible()

  const node = page.locator('.react-flow__node').first()
  await node.dragTo(page.locator('.react-flow__pane'), { targetPosition: { x: 520, y: 260 } })
  const saved = await page.evaluate(() => localStorage.getItem('kogwistar.workflow.layout.demo.goal-loop'))
  expect(saved).toContain('observe')
  expect(saved).toContain('viewport')

  await page.getByRole('button', { name: 'zoom in' }).click()
  await page.getByRole('button', { name: 'zoom out' }).click()
  await page.getByRole('button', { name: 'fit view' }).click()
  await page.reload()
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  expect(await page.evaluate(() => localStorage.getItem('kogwistar.workflow.layout.demo.goal-loop'))).toBe(saved)
})

test('connecting handles persists an ordinary wf_next edge', async ({ page }) => {
  const mutations: Array<{ method: string; url: string; body: Record<string, unknown> }> = []
  page.on('request', request => {
    if (request.url().endsWith('/edges') && request.method() === 'POST') {
      mutations.push({ method: request.method(), url: request.url(), body: request.postDataJSON() })
    }
  })
  await page.goto('/')
  const source = page.locator('.react-flow__handle.source').first()
  const target = page.locator('.react-flow__handle.target').nth(1)
  await source.dragTo(target)
  await expect.poll(() => mutations.length).toBe(1)
  expect(mutations[0].body).toMatchObject({
    designer_id: 'designer@example.test',
    src: 'observe',
    dst: 'act',
    relation: 'wf_next',
  })
})

test('keyboard delete does not bypass explicit deletion controls', async ({ page }) => {
  const deletes: string[] = []
  page.on('request', request => {
    if (request.method() === 'DELETE') deletes.push(request.url())
  })
  await page.goto('/')
  await page.locator('.react-flow__node').first().click()
  await page.keyboard.press('Delete')
  await page.keyboard.press('Backspace')
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  expect(deletes).toHaveLength(0)
})
