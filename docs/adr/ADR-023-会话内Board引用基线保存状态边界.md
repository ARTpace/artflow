# ADR-023：会话内 Board 引用基线保存状态边界

- **状态**：accepted（已验证）
- **日期**：2026-09-22
- **关联**：ADR-003、ADR-019、ADR-021

## Context

Board data changes immutably in `useCanvasState`, but existing UI only exposes an action and its immediate result. Users cannot inspect whether a later camera/bookmark/content change needs a new ordinary Save. A persistent dirty marker or project hash would affect storage semantics; a simple in-memory baseline can improve visibility without taking ownership from `useFileSystem`.

## Decision

1. Add a pure `projectChangeTracker.ts` state transition helper whose only comparison is Board-array reference identity. It initializes/accepts a baseline clean, makes a changed reference dirty, and accepts a save completion only if its saved snapshot is still current.
2. Extend `useCanvasState.loadBoardData` to return `boolean`: true only after a nonempty normalized Board[] is applied. App uses it to declare loaded baseline only for a real load.
3. App owns tracker refs/state around existing open/save handlers. It passes scalar `hasUnsavedChanges` / `hasProjectSaveBaseline` to R19 WorkspaceStatusDock and ProjectWorkspacePanel.
4. Do not alter `useFileSystem.saveProject`, Project Document serialization, storage, protocol, or close behavior. State copy explicitly says it is an in-memory, last-successful-save signal.

## Consequences

- Users receive a consistent visible save indicator in both browser and managed UI paths.
- Board-only state means selection and temporary R22 Finder UI do not create false dirty changes.
- Reference equality is fast and matches current immutable updates, but is deliberately not a content hash or filesystem audit.

## Rejected alternatives

- **Serialize/deep compare every render**：would duplicate persistence work, create performance risk and blur serializer ownership.
- **Persistent dirty table/localStorage**：would be stale across crashes and introduce storage ownership without recovery semantics.
- **Change `saveProject` to report/own dirty state**：would couple UI/session policy to picker/fallback/managed materialization and duplicate App orchestration.
- **Autosave/close prompts now**：require explicit failure/recovery and platform policy beyond a visibility feature.

## Revisit triggers

Need autosave, before-close confirmation, durable dirty/revision marker, crash recovery, filesystem watcher, multi-window conflict or cloud sync when a new FDD/ADR explicitly owns persistence/recovery semantics.


## Implementation evidence（2026-09-22）

- Implementation is renderer/session-only: `utils/projectChangeTracker.ts`, a boolean `loadBoardData` acceptance signal, `App.tsx`, and R19 `ProjectWorkspacePanel`; no `useFileSystem`, serializer, main/preload/repository/schema/dependency diff exists.
- The tracker intentionally compares only Board-array identity. It accepts a successful nonempty load or still-current successful save as baseline and leaves a concurrent later Board update dirty.
- Workspace copy says “session-local Board change signal, not an autosave or disk audit”; no close prompt, autosave, persistent marker or sync behavior was introduced.
- Remote `typecheck`, `check:foundations` and full `check` all exited 0; foundation retains fixed 13-capability assertions.
