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

const routeGraph = {
  current_version: 3,
  nodes: [
    { id: 'router', label: 'Router', x: 120, y: 120, metadata: { wf_op: 'noop', wf_start: true, wf_child_workflow_id: 'child.workflow' } },
    { id: 'left', label: 'Left', x: 380, y: 40, metadata: { wf_op: 'noop' } },
    { id: 'right', label: 'Right', x: 380, y: 220, metadata: { wf_op: 'noop' } },
  ],
  edges: [
    { id: 'route-true', source_ids: ['router'], target_ids: ['left'], metadata: { wf_predicate: 'is_ready', wf_priority: 10, wf_multiplicity: 'many' } },
    { id: 'route-default', source_ids: ['router'], target_ids: ['right'], metadata: { wf_is_default: true, wf_priority: 100, wf_multiplicity: 'one' } },
    { id: 'route-loop', source_ids: ['router'], target_ids: ['router'], metadata: { wf_predicate: 'retry', wf_priority: 20, wf_multiplicity: 'one' } },
  ],
}

const missingChildGraph = {
  ...graph,
  nodes: [{ ...graph.nodes[0], metadata: { ...graph.nodes[0].metadata, wf_child_workflow_id: 'missing.workflow' } }, ...graph.nodes.slice(1)],
}

const privateChildGraph = {
  ...graph,
  nodes: [{ ...graph.nodes[0], metadata: { ...graph.nodes[0].metadata, wf_child_workflow_id: 'private.workflow' } }, ...graph.nodes.slice(1)],
}

const cycleGraph = {
  ...graph,
  nodes: [{ ...graph.nodes[0], metadata: { ...graph.nodes[0].metadata, wf_child_workflow_id: 'cycle' } }, ...graph.nodes.slice(1)],
}

const depthGraph = (depth: number) => ({
  ...graph,
  nodes: [{ ...graph.nodes[0], metadata: { ...graph.nodes[0].metadata, wf_child_workflow_id: `depth-${depth + 1}` } }, ...graph.nodes.slice(1)],
})

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith('/graph')) {
      if (url.pathname.includes('missing.workflow')) return route.fulfill({ status: 404, json: { detail: 'Workflow not found' } })
      if (url.pathname.includes('private.workflow')) return route.fulfill({ status: 403, json: { detail: 'Workflow access denied' } })
      const depthMatch = url.pathname.match(/\/depth-(\d+)\/graph$/)
      if (depthMatch) return route.fulfill({ json: depthGraph(Number(depthMatch[1])) })
      return route.fulfill({ json: url.pathname.includes('child.workflow') ? graph : url.pathname.includes('cycle.workflow') || url.pathname.includes('/cycle/') ? cycleGraph : url.pathname.includes('routes') ? routeGraph : url.pathname.includes('/missing') ? missingChildGraph : url.pathname.includes('/private') ? privateChildGraph : graph })
    }
    if (url.pathname.endsWith('/catalog/ops')) return route.fulfill({ json: [{ op: 'noop', label: 'No-op' }] })
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: { can_undo: true, can_redo: false } })
    if (url.pathname.endsWith('/runs/run-42/events')) return route.fulfill({ json: [{ type: 'edge_selected', edge_id: 'route-true' }] })
    if (url.pathname.endsWith('/me')) return route.fulfill({ json: { email: 'designer@example.test' } })
    if (request.method() === 'POST' || request.method() === 'DELETE') return route.fulfill({ json: { version: 8 } })
    return route.fulfill({ status: 404, json: { detail: 'mock route missing' } })
  })
})

test('loads graph, edits selection, persists layout, and restores viewport', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Workflow Studio' })).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  await expect(page.locator('.subtle').first()).toHaveText(/3 nodes.*1 edges.*1 terminals.*1 routed/)
  await page.screenshot({ path: testInfo.outputPath('workflow-studio-desktop.png'), fullPage: true })
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
  const savedAfterViewportChange = await page.evaluate(() => localStorage.getItem('kogwistar.workflow.layout.demo.goal-loop'))
  await page.reload()
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  expect(await page.evaluate(() => localStorage.getItem('kogwistar.workflow.layout.demo.goal-loop'))).toBe(savedAfterViewportChange)
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

test('mobile layout remains usable and malformed saved layout is ignored', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('kogwistar.workflow.layout.demo.goal-loop', '{not-json'))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Workflow Studio' })).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  await expect(page.locator('.workspace')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('workflow-studio-mobile.png'), fullPage: true })
})

test('keeps parallel route metadata visible, overlays selected run routes, and opens guarded child workflow canvas', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('kogwistar.workflow.layout.routes', JSON.stringify({ nodes: { router: { x: 11, y: 12 } }, viewport: { x: 1, y: 2, zoom: 1 } }))
    localStorage.setItem('kogwistar.workflow.layout.child.workflow', JSON.stringify({ nodes: { observe: { x: 91, y: 92 } }, viewport: { x: 9, y: 8, zoom: 1.2 } }))
  })
  await page.goto('/')
  await page.getByLabel('Workflow ID').fill('routes')
  await page.getByLabel('Run ID').fill('run-42')
  await page.getByRole('button', { name: 'Load design' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  await expect(page.locator('.react-flow__edge-text')).toHaveCount(3)
  await expect(page.locator('.react-flow__edge-text').filter({ hasText: 'is_ready' })).toBeVisible()
  await expect(page.locator('.react-flow__edge-text').filter({ hasText: 'default' })).toBeVisible()
  await expect.poll(async () => page.locator('.react-flow__edge-path').evaluateAll(paths => paths.map(path => path.getAttribute('style') || '').join('\n'))).toContain('stroke: rgb(234, 118, 95); stroke-width: 4')
  await page.screenshot({ path: testInfo.outputPath('workflow-studio-routes.png'), fullPage: true })
  await page.locator('.react-flow__node').first().click()
  await page.getByRole('button', { name: /Open subworkflow/ }).click()
  await expect(page.getByRole('button', { name: 'child.workflow' })).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  expect(await page.evaluate(() => localStorage.getItem('kogwistar.workflow.layout.routes'))).toContain('"router"')
  expect(await page.evaluate(() => localStorage.getItem('kogwistar.workflow.layout.child.workflow'))).toContain('"observe"')
})

test('surfaces missing and unauthorized child workflow errors', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Workflow ID').fill('missing')
  await page.getByRole('button', { name: 'Load design' }).click()
  await page.locator('.react-flow__node').first().click()
  await page.getByRole('button', { name: /Open subworkflow/ }).click()
  await expect(page.locator('.status')).toContainText('Workflow not found')

  await page.getByRole('button', { name: 'missing', exact: true }).click()
  await page.getByLabel('Workflow ID').fill('private')
  await page.getByRole('button', { name: 'Load design' }).click()
  await page.locator('.react-flow__node').first().click()
  await page.getByRole('button', { name: /Open subworkflow/ }).click()
  await expect(page.locator('.status')).toContainText('Workflow access denied')
})

test('guards cyclic subworkflow navigation without opening a duplicate canvas', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Workflow ID').fill('cycle')
  await page.getByRole('button', { name: 'Load design' }).click()
  await page.locator('.react-flow__node').first().click()
  await page.getByRole('button', { name: /Open subworkflow/ }).click()
  await expect(page.locator('.status')).toContainText('already open in this path')
})

test('enforces maximum nested subworkflow canvas depth', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Workflow ID').fill('depth-0')
  await page.getByRole('button', { name: 'Load design' }).click()
  for (let depth = 0; depth < 7; depth += 1) {
    await page.locator('.react-flow__node').first().click()
    await page.getByRole('button', { name: /Open subworkflow/ }).click()
    await expect(page.locator('.react-flow__node')).toHaveCount(3)
  }
  await page.locator('.react-flow__node').first().click()
  await page.getByRole('button', { name: /Open subworkflow/ }).click()
  await expect(page.locator('.status')).toContainText('depth limit reached')
})
