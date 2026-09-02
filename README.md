# Kogwistar Workflow Studio

Standalone XYFlow editor for Kogwistar workflow designs. It edits ordinary
workflow nodes and edges through the existing runtime API; it is not another
workflow engine.

## Run

Requires Node 20.13+.

```powershell
npm install
npm run dev
```

The client expects Kogwistar at `http://127.0.0.1:28110`. Override it with:

```powershell
$env:VITE_KOGWISTAR_API_ROOT = 'http://127.0.0.1:28110'
npm run dev
```

Production checks:

```powershell
npm run build
npm run lint
```

## Backend contract

The app uses these existing endpoints:

| UI action | Kogwistar endpoint |
| --- | --- |
| Load graph | `GET /api/workflow/design/{id}/graph` |
| Load resolver catalog | `GET /api/workflow/catalog/ops` |
| Load history | `GET /api/workflow/design/{id}/history` |
| Add or edit node | `POST /api/workflow/design/{id}/nodes` |
| Add or edit edge | `POST /api/workflow/design/{id}/edges` |
| Delete node or edge | `DELETE /api/workflow/design/{id}/nodes/{node}` or `/edges/{edge}` |
| Undo / redo | `POST /api/workflow/design/{id}/undo` or `/redo` |

XYFlow node positions are editor presentation state. They are stored in
browser `localStorage` by workflow ID and never become workflow execution
truth. Node labels, resolver operations, start/terminal flags, metadata, edge
predicates, and graph history remain Kogwistar data.

## Authentication and authorization

Sign in uses Kogwistar's existing `/api/auth/login` flow. A returned token is
kept in browser session storage and sent as a Bearer token. Role, namespace,
workflow ACL, and read/write enforcement remain entirely server-side; the UI
does not replace those checks. Graph/catalog reads require read access, while
mutations require write access.

## Design semantics

The canvas exposes ordinary Kogwistar graph semantics: nodes, directed
`wf_next` edges, predicates, resolver operations, start/terminal metadata, and
reversible design history. Goal workflows are represented by their ordinary
cyclic graph and optional metadata, not by a second editor runtime.
