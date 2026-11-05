# ADR-019：工作区状态与 managed/browser 可见性边界

- **状态**：accepted（已验证）
- **日期**：2026-09-22
- **关联**：ADR-005、ADR-009、ADR-010、ADR-018

## Context

R18 正确地把 durable import jobs 限定在 managed Electron project 中，防止 browser fallback 误获得 privileged storage capability。但结果是默认画布看不出目前是哪个 storage mode，也看不出打开/保存操作的实际语义；被条件隐藏的 R18 panel 容易被误解为“没有 UI 改动”。

## Decision

1. 建立 renderer-only `WorkspaceStatusDock` 和 `ProjectWorkspacePanel`，以现有 App state 解释当前 workspace；dock 在非 presentation mode 始终可见。
2. panel 只接收 scalar presentation data 和 existing callbacks：project name/open state、managed-runtime boolean、board/element/asset-linked/frame/selection metrics、save busy state、open/save/import actions。
3. managed-runtime 和 managed-import-jobs capability 必须分开：runtime capability 可在 project 未选中时显示 desktop storage；R18 Import Jobs action 仍只在 existing open-project `isManagedImportJobsAvailable` 为真时出现。
4. Browser mode 只显示已有 JSON/browser-folder storage copy 和 Open/Save callback，不展示 job list、job status、cancel 或任何看似 durable import 的入口。
5. 不新增 IPC、repository read、schema、dependency 或 event stream。panel 不知道 staging/raw bytes/path/hash，也不独立调用 import-job bridge。

## Consequences

- 用户在任何 UI runtime 都可见“这是什么工作区、保存意味着什么”，R18 hidden-by-design 的限制变得可解释。
- 因为 metrics 来自 React state，显示的是 current canvas，不是 authoritative persisted repository inventory；文案必须准确。
- `ImportJobsPanel` 继续是唯一 job journal UI；Project panel 只是受条件保护的 navigation point。
- 这个 ADR 不授权 recent projects、autosave、sync、project lifecycle ownership 或 R18 queue policy 的扩展。

## Rejected alternatives

- **在 browser fallback 伪造或复刻 Import Jobs**：会混淆 R9/R18 durable semantics，也可能诱导 renderer 假设无 bridge 的能力。
- **为 panel 添加 generic status IPC / path access**：没有必要，且会扩大 security boundary。
- **将 workspace stats 写入 SQLite**：当前 UI 只需 React state；增加 persistence 没有用户价值且违反最小范围。

## Verification record (2026-09-22)

- Remote `npm --prefix artflow run typecheck` exit 0.
- Remote `npm --prefix artflow run check:foundations` exit 0；static contracts prove the renderer-only dock/panel, browser/managed wording, existing R18 conditional navigation, no panel bridge symbols, truthful save-cancel branch and unchanged 13 fixed capabilities.
- Remote `npm --prefix artflow run check` exit 0（typecheck + Vite production build + foundation）；only existing Vite chunk-size and Node SQLite experimental warnings remain. Final R19 source/governance exact read-back matched.

## Revisit triggers

需要 recent-project picker、saved-revision badges、autosave/sync receipt、cloud collaboration、repository-wide unique asset inventory 或 browser durable import 时，必须新建 FDD/ADR。
