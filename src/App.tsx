import { useCallback, useEffect, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './App.css'

type NodeData = { label?: string; metadata?: Record<string, unknown> }
type WorkflowNode = Node<NodeData>
type ApiGraph = {
  current_version?: number
  materialization_status?: string
  nodes?: Array<Record<string, unknown>>
  edges?: Array<Record<string, unknown>>
}
type Layout = {
  nodes: Record<string, { x: number; y: number }>
  viewport?: { x: number; y: number; zoom: number }
}

type WorkflowView = { id: string; label: string }

const API_ROOT = import.meta.env.VITE_KOGWISTAR_API_ROOT || 'http://127.0.0.1:28110'
const layoutKey = (workflowId: string) => `kogwistar.workflow.layout.${workflowId}`

function readLayout(workflowId: string): Layout | null {
  try {
    const raw = localStorage.getItem(layoutKey(workflowId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Layout
    return parsed && typeof parsed.nodes === 'object' ? parsed : null
  } catch {
    return null
  }
}

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem('kogwistar_access_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options?.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(body.detail || (response.status === 401 ? 'Sign in required' : `Request failed (${response.status})`))
  }
  return body as T
}

function normalizeGraph(graph: ApiGraph, layout: Layout | null, selectedEdgeIds = new Set<string>()): { nodes: WorkflowNode[]; edges: Edge[] } {
  const nodes = (graph.nodes || []).map((raw, index) => {
    const id = String(raw.id || `node-${index}`)
    const metadata = (raw.metadata as Record<string, unknown>) || {}
    const saved = layout?.nodes?.[id]
    return {
      id,
      type: 'default',
      position: saved || { x: Number(raw.x ?? 120 + (index % 4) * 220), y: Number(raw.y ?? 100 + Math.floor(index / 4) * 150) },
      data: { label: String(raw.label || id), metadata },
    }
  })
  const parallelCounts = new Map<string, number>()
  const edges = (graph.edges || []).map((raw, index) => {
    const metadata = (raw.metadata as Record<string, unknown>) || {}
    const sourceIds = (raw.source_ids as string[] | undefined) || []
    const targetIds = (raw.target_ids as string[] | undefined) || []
    const source = String(sourceIds[0] || raw.src || '')
    const target = String(targetIds[0] || raw.dst || '')
    const key = `${source}->${target}`
    const parallelIndex = parallelCounts.get(key) || 0
    parallelCounts.set(key, parallelIndex + 1)
    const predicate = metadata.wf_predicate ? String(metadata.wf_predicate) : ''
    const defaultLabel = Boolean(metadata.wf_is_default) ? 'default' : ''
    const priority = metadata.wf_priority == null ? '' : `p${String(metadata.wf_priority)}`
    const multiplicity = metadata.wf_multiplicity ? String(metadata.wf_multiplicity) : ''
    const labels = [predicate, defaultLabel, priority, multiplicity].filter(Boolean)
    const selfLoop = source === target
    return {
      id: String(raw.id || `edge-${index}`),
      source,
      target,
      label: labels.join(' · '),
      type: selfLoop ? 'default' : 'smoothstep',
      pathOptions: { offset: 18 + parallelIndex * 22, borderRadius: 12 },
      style: { stroke: selectedEdgeIds.has(String(raw.id || `edge-${index}`)) ? '#ea765f' : selfLoop ? '#ea765f' : parallelIndex ? '#197c71' : '#91a79c', strokeWidth: selectedEdgeIds.has(String(raw.id || `edge-${index}`)) ? 4 : parallelIndex ? 2.5 : 2 },
      data: { metadata, parallelIndex, selfLoop },
    }
  }).filter(edge => edge.source && edge.target)
  return { nodes, edges }
}

function Studio() {
  const [workflowId, setWorkflowId] = useState('demo.goal-loop')
  const [designerId, setDesignerId] = useState('designer-local')
  const [nodes, setNodes] = useState<WorkflowNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [catalog, setCatalog] = useState<Array<Record<string, unknown>>>([])
  const [selected, setSelected] = useState<{ type: 'node' | 'edge'; id: string } | null>(null)
  const [message, setMessage] = useState('Ready for a workflow')
  const [instance, setInstance] = useState<ReactFlowInstance<WorkflowNode, Edge> | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [runId, setRunId] = useState('')
  const [loadedWorkflowId, setLoadedWorkflowId] = useState<string | null>(null)
  const [viewStack, setViewStack] = useState<WorkflowView[]>([{ id: workflowId, label: workflowId }])
  const activeWorkflowId = viewStack[viewStack.length - 1]?.id || workflowId

  const load = useCallback(async () => {
    try {
      setMessage('Loading workflow...')
      const saved = readLayout(activeWorkflowId)
      const [graph, ops, history] = await Promise.all([
        request<ApiGraph>(`/api/workflow/design/${encodeURIComponent(activeWorkflowId)}/graph`),
        request<Array<Record<string, unknown>>>('/api/workflow/catalog/ops'),
        request<Record<string, unknown>>(`/api/workflow/design/${encodeURIComponent(workflowId)}/history`),
      ])
      const selectedEdgeIds = new Set<string>()
      if (runId.trim()) {
        try {
          const eventBody = await request<unknown>(`/api/workflow/runs/${encodeURIComponent(runId.trim())}/events`)
          const events = Array.isArray(eventBody) ? eventBody : ((eventBody as { events?: unknown[] })?.events || [])
          for (const event of events) {
            const item = event as { type?: string; edge_id?: string; payload?: { edge_id?: string } }
            if (item.type === 'edge_selected' && (item.edge_id || item.payload?.edge_id)) selectedEdgeIds.add(String(item.edge_id || item.payload?.edge_id))
          }
        } catch { setMessage('Workflow loaded · run provenance unavailable') }
      }
      const normalized = normalizeGraph(graph, saved, selectedEdgeIds)
      setNodes(normalized.nodes)
      setEdges(normalized.edges)
      setCatalog(ops)
      setSelected(null)
      setLoadedWorkflowId(activeWorkflowId)
      setMessage(history.can_undo || history.can_redo ? 'Design loaded · history available' : 'Design loaded')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load workflow')
    }
  }, [activeWorkflowId, runId])

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token')
    if (token) {
      sessionStorage.setItem('kogwistar_access_token', token)
      window.history.replaceState({}, document.title, window.location.pathname)
    }
    request<{ email?: string; user_id?: string }>('/api/auth/me')
      .then(me => setDesignerId(me.email || me.user_id || 'designer-local'))
      .catch(() => undefined)
      .finally(() => setAuthReady(true))
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const saved = readLayout(activeWorkflowId)
    if (instance && saved?.viewport) instance.setViewport(saved.viewport)
  }, [instance, activeWorkflowId])

  const saveLayout = useCallback((nextNodes = nodes) => {
    if (!nextNodes.length || loadedWorkflowId !== activeWorkflowId) return
    const value: Layout = {
      nodes: Object.fromEntries(nextNodes.map(node => [node.id, node.position])),
      viewport: instance?.getViewport(),
    }
    localStorage.setItem(layoutKey(activeWorkflowId), JSON.stringify(value))
  }, [instance, nodes, activeWorkflowId, loadedWorkflowId])
  const mutate = async (path: string, body: unknown, method = 'POST') => {
    try {
      const result = await request<{ version?: number }>(path, { method, body: JSON.stringify(body) })
      setMessage(method === 'DELETE' ? 'Mutation committed' : `Saved at v${result.version ?? '?'}`)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Mutation failed')
    }
  }
  const onNodesChange = useCallback((changes: NodeChange<WorkflowNode>[]) => {
    if (changes.some(change => change.type === 'remove')) setMessage('Use the inspector Delete button to remove a node')
    setNodes(current => applyNodeChanges(changes.filter(change => change.type !== 'remove'), current))
  }, [])
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (changes.some(change => change.type === 'remove')) setMessage('Use the inspector Delete button to remove an edge')
    setEdges(current => applyEdgeChanges(changes.filter(change => change.type !== 'remove'), current))
  }, [])
  const onConnect = useCallback((connection: Connection) => {
    if (!authReady) {
      setMessage('Waiting for authentication')
      return
    }
    if (!connection.source || !connection.target) return
    void mutate(`/api/workflow/design/${encodeURIComponent(workflowId)}/edges`, {
      designer_id: designerId,
      src: connection.source,
      dst: connection.target,
      relation: 'wf_next',
      is_default: true,
      metadata: {},
    })
  }, [authReady, designerId, workflowId])
  const onNodeDragStop = useCallback((_: unknown, node: WorkflowNode) => {
    saveLayout(nodes.map(current => current.id === node.id ? { ...current, position: node.position } : current))
  }, [nodes, saveLayout])
  const saveNode = (node: WorkflowNode) => {
    let metadata: Record<string, unknown>
    try { metadata = JSON.parse((document.getElementById('node-meta') as HTMLTextAreaElement).value || '{}') } catch { setMessage('Metadata must be valid JSON'); return }
    metadata.wf_op = (document.getElementById('node-op') as HTMLInputElement).value || 'noop'
    metadata.wf_start = (document.getElementById('node-start') as HTMLSelectElement).value === 'true'
    metadata.wf_terminal = (document.getElementById('node-terminal') as HTMLSelectElement).value === 'true'
    void mutate(`/api/workflow/design/${encodeURIComponent(workflowId)}/nodes`, { designer_id: designerId, node_id: node.id, label: (document.getElementById('node-label') as HTMLInputElement).value || node.data.label, op: String(metadata.wf_op), start: Boolean(metadata.wf_start), terminal: Boolean(metadata.wf_terminal), fanout: Boolean(metadata.wf_fanout), metadata })
  }
  const saveEdge = (edge: Edge) => {
    const metadata = { ...((edge.data?.metadata as Record<string, unknown>) || {}), wf_predicate: (document.getElementById('edge-predicate') as HTMLInputElement).value || null }
    void mutate(`/api/workflow/design/${encodeURIComponent(workflowId)}/edges`, { designer_id: designerId, edge_id: edge.id, src: edge.source, dst: edge.target, relation: 'wf_next', predicate: metadata.wf_predicate, is_default: true, metadata })
  }
  const selectedNode = selected?.type === 'node' ? nodes.find(node => node.id === selected.id) : undefined
  const selectedEdge = selected?.type === 'edge' ? edges.find(edge => edge.id === selected.id) : undefined
  const terminalCount = nodes.filter(node => Boolean(node.data.metadata?.wf_terminal)).length
  const routedCount = edges.filter(edge => Boolean(edge.label)).length
  const childWorkflow = selectedNode?.data.metadata?.wf_child_workflow_id || selectedNode?.data.metadata?.wf_subworkflow_id
  const runtimeInvocation = selectedNode?.data.metadata?.wf_invoked
  const runtimeChild = typeof runtimeInvocation === 'string'
    ? runtimeInvocation
    : runtimeInvocation && typeof runtimeInvocation === 'object'
      ? String((runtimeInvocation as Record<string, unknown>).workflow_id || (runtimeInvocation as Record<string, unknown>).child_workflow_id || '')
      : ''
  const childReference = typeof childWorkflow === 'string' ? childWorkflow : runtimeChild || undefined
  const unresolvedRuntimeChild = Boolean(runtimeInvocation) && !runtimeChild
  const openChild = () => {
    if (!childReference || viewStack.some(view => view.id === childReference) || viewStack.length >= 8) {
      setMessage(viewStack.length >= 8 ? 'Subworkflow depth limit reached' : 'Subworkflow is already open in this path')
      return
    }
    setViewStack(stack => [...stack, { id: childReference, label: childReference }])
    setSelected(null)
  }

  return <main className="shell">
    <header><div><div className="eyebrow">Kogwistar / graph-native design</div><h1>Workflow Studio</h1><p className="lede">Compose ordinary nodes, route with predicates, and keep reversible design history close to the graph.</p></div><div className="status"><span className="status-dot" />{message}<a href={`${API_ROOT}/api/auth/login?return_to=${encodeURIComponent(window.location.href)}`}>Sign in</a></div></header>
    <section className="toolbar"><input aria-label="Workflow ID" value={workflowId} onChange={event => { setWorkflowId(event.target.value); setLoadedWorkflowId(null); setViewStack([{ id: event.target.value, label: event.target.value }]) }} /><input aria-label="Run ID" placeholder="Optional run for selected routes" value={runId} onChange={event => setRunId(event.target.value)} /><input aria-label="Designer ID" value={designerId} onChange={event => setDesignerId(event.target.value)} /><button className="primary" onClick={load}>Load design</button><button disabled={!authReady} onClick={() => mutate(`/api/workflow/design/${encodeURIComponent(activeWorkflowId)}/nodes`, { designer_id: designerId, label: 'New step', op: String(catalog.find(op => op.op === 'llm_call')?.op || catalog[0]?.op || 'noop'), metadata: {} })}>+ Node</button><button onClick={() => instance?.fitView({ padding: .2 })}>Fit</button><button disabled={!authReady} onClick={() => mutate(`/api/workflow/design/${encodeURIComponent(activeWorkflowId)}/undo`, { designer_id: designerId })}>Undo</button><button disabled={!authReady} onClick={() => mutate(`/api/workflow/design/${encodeURIComponent(activeWorkflowId)}/redo`, { designer_id: designerId })}>Redo</button></section>
    <nav className="breadcrumbs" aria-label="Workflow breadcrumbs">{viewStack.map((view, index) => <span key={view.id}>{index > 0 && <span className="crumb-separator">›</span>}<button className={index === viewStack.length - 1 ? 'current' : ''} onClick={() => { setViewStack(stack => stack.slice(0, index + 1)); setSelected(null) }}>{view.label}</button></span>)}</nav>
    <section className="workspace"><div className="canvas card"><ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_, node) => setSelected({ type: 'node', id: node.id })} onEdgeClick={(_, edge) => setSelected({ type: 'edge', id: edge.id })} onPaneClick={() => setSelected(null)} onNodeDragStop={onNodeDragStop} onMoveEnd={() => saveLayout()} onInit={flow => { setInstance(flow); const saved = readLayout(activeWorkflowId); if (saved?.viewport) flow.setViewport(saved.viewport) }} fitView={false}><Background color="#c8d8cf" gap={24} /><Controls /><MiniMap nodeColor={node => { const metadata = (node.data as NodeData | undefined)?.metadata; return metadata?.wf_terminal ? '#efbd59' : metadata?.wf_start ? '#b7e4cc' : '#fff' }} /></ReactFlow><div className="canvas-note">scroll zoom · drag canvas to pan · drag nodes to save layout</div></div>
      <aside className="card inspector"><h2>Design signals</h2><p className="subtle">{nodes.length} nodes · {edges.length} edges · {terminalCount} terminals · {routedCount} routed</p><div className="chips"><span>start</span><span>terminal</span><span>predicate</span>{nodes.some(node => node.data.metadata?.wf_mode === 'goal') && <span className="goal">goal profile</span>}</div><hr />{selectedNode ? <><h2>Node</h2><p className="mono">{selectedNode.id}</p>{childReference && <button className="primary" onClick={openChild}>Open subworkflow · {childReference}</button>}{unresolvedRuntimeChild && <p className="subtle">Runtime child unresolved until wf_invoked provenance is available.</p>}<label>Label<input id="node-label" defaultValue={selectedNode.data.label} /></label><label>Resolver op<input id="node-op" list="ops" defaultValue={String(selectedNode.data.metadata?.wf_op || 'noop')} /></label><div className="split"><label>Start<select id="node-start" defaultValue={String(Boolean(selectedNode.data.metadata?.wf_start))}><option value="false">no</option><option value="true">yes</option></select></label><label>Terminal<select id="node-terminal" defaultValue={String(Boolean(selectedNode.data.metadata?.wf_terminal))}><option value="false">no</option><option value="true">yes</option></select></label></div><label>Metadata JSON<textarea id="node-meta" defaultValue={JSON.stringify(selectedNode.data.metadata || {}, null, 2)} /></label><div className="actions"><button disabled={!authReady} className="primary" onClick={() => saveNode(selectedNode)}>Save node</button><button disabled={!authReady} className="danger" onClick={() => mutate(`/api/workflow/design/${encodeURIComponent(activeWorkflowId)}/nodes/${encodeURIComponent(selectedNode.id)}`, { designer_id: designerId }, 'DELETE')}>Delete</button></div></> : selectedEdge ? <><h2>Edge</h2><p className="mono">{selectedEdge.source} -&gt; {selectedEdge.target}</p><label>Route metadata<input id="edge-predicate" defaultValue={String(selectedEdge.label || '')} /></label><div className="actions"><button disabled={!authReady} className="primary" onClick={() => saveEdge(selectedEdge)}>Save edge</button><button disabled={!authReady} className="danger" onClick={() => mutate(`/api/workflow/design/${encodeURIComponent(activeWorkflowId)}/edges/${encodeURIComponent(selectedEdge.id)}`, { designer_id: designerId }, 'DELETE')}>Delete</button></div></> : <><h2>Inspector</h2><p className="subtle">Select node/edge to edit graph semantics. Connect handles to create routing edges.</p></>}</aside></section>
    <datalist id="ops">{catalog.map(op => <option key={String(op.op)} value={String(op.op)}>{String(op.label || op.op)}</option>)}</datalist>
  </main>
}

export default function App() { return <ReactFlowProvider><Studio /></ReactFlowProvider> }
