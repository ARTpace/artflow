# FDD-018：Phase 2g —— 持久导入任务可观测与恢复 UI

- **状态**：verified
- **日期**：2026-09-22
- **轮次**：R18
- **关联**：FDD-009 / ADR-009（raw staging 与 durable job）、FDD-010 / ADR-010（managed save consumer）

## 1. 背景与目标

R9 已将 renderer raw bytes 的 staged import intent/outcome 做成可 reopen 的 durable FIFO，R10 又让 managed save 实际消费该 job。但 renderer 目前只显示笼统的 “Saving project…”：用户看不到正在处理哪个 asset、恢复后的 queued/running job、失败状态，也无法对 queued job 发出既有的取消请求。这个基础能力因此尚未形成可感知的完整导入体验。

本轮把已经存在的 durable job 链路做成一个可见的纵向能力：项目打开后可安全读取**有上限的脱敏 job summaries**；保存期间显示当前 asset/job 状态；Import Jobs 面板显示 active 与 recent terminal jobs，并复用既有 cancel API。它不把 parser、board insertion、retry 或 transaction 一次性混入。

## 2. Ponytail 七步决策记录

1. **需要性**：需要。R9/R10 的 durable lifecycle 已存在，但用户无法验证恢复、进度或 failure，造成“底层做了、产品无感”的断层。
2. **已有能力**：复用 R9 `AssetImportController`、repository journal、request/get/cancel named APIs 与 R10 materializer poll；repository 已有 private `listImportJobs`，不新建 DB/queue。
3. **标准库**：仅使用 React state/effect 与 timer；不加状态库或 queue dependency。
4. **平台特性**：新增一个受 trusted-main-frame guard 保护、无参数、固定上限的 `listImportJobs` named preload/API；绝不暴露 IPC、path、staging hash、raw bytes 或 SQL。
5. **依赖**：无新增 npm dependency。
6. **一行方案**：不成立。需同时冻结 summary redaction/bound、active/recent ordering、save observer lifecycle、poll cleanup、queued vs running cancel acknowledgement 和 browser fallback。
7. **最小实现**：controller safe `listJobs()` → fixed bounded bridge → hook-owned refresh/poll + materializer observer → compact renderer panel；不扩展 scheduler policy。

## 3. 范围

### 3.1 必须实现

- `AssetImportController.listJobs()` 只返回至多 **25** 个 safe snapshots：active (`queued`/`running`) 按 FIFO 优先，最近 terminal 记录补足剩余容量；不得返回 draft、staging hash/path/byte buffer、renderer locator reference 或 repository handle。
- Safe snapshot 可含 job id、asset id、display name、status/progress/error code、safe completed result 与 created/updated timestamp；display name 只来自既有 original name / safe draft metadata，不是 native path。
- `ProjectStorageController`、`main.cjs`、`preload.cjs`、`ArtflowStorageApi` 增加一个 `listImportJobs()` named task。fixed capability 总数由 12 变为 **13**；每个 IPC handler 保持 existing trusted sender check。
- `materializeManagedProjectDocument` 增加 optional observer（兼容旧调用）；每次 request、poll status change、terminal state 都报告当前 asset ordinal/total 与 safe job snapshot，不改变 R10 completed-result authority。
- `useFileSystem` 只在 managed project open 时 refresh/poll safe list；save observer 驱动 current progress，终止、错误、unmount 与 project switch 都清理 polling / stale state。
- 新的 Import Jobs 面板显示恢复说明、当前 save/import job、active/recent terminal jobs、failure error code，并能对 active job 发送 existing cancel request。running cancel 只能标记请求，不能承诺绕过不可中断 promotion；browser/legacy mode 不显示此 panel。
- foundation 覆盖 bounded/redacted summary、active/recent ordering、new fixed channel + sender guard、observer event order/compatibility、hook/panel wiring、capability count 13。

### 3.2 明确不做

- 不做 directory/batch raw picker、automatic board/node insertion、parser/thumbnail Worker、retry/priority/multi-worker、transactional document+job commit、GC/retention、staging encryption、streaming/range、multi-window coordination。
- 不改变 R9 stage-before-journal、single-concurrency FIFO、close vs explicit cancel、R10 save terminal-result rule，或 R4 repository ownership。
- 不开放 generic IPC/filesystem/database/path/staging hash/raw bytes，也不将 saved R12/R13 query 接入该 UI。

## 4. 语义契约

```ts
// Electron only: a bounded, presentation-safe view over an existing durable journal.
const jobs = await window.artflowStorage.listImportJobs();
// jobs.length <= 25; no staging path/hash, raw bytes, draft or runtime locator.

await materializeManagedProjectDocument(document, storage, {
  onImportJobUpdate: event => setCurrentImportProgress(event),
});
```

- Summary listing is observational. Only existing `requestImport` / `getImportJob` / `cancelImportJob` mutate job lifecycle.
- R10 save remains sequential and only commits a project document after every needed asset yields a valid completed result.
- A cancel button issues a request; a queued job becomes cancelled, while a running job may safely finish after its irreversible commit point. UI must represent the returned/current status rather than promise cancellation.
- Active jobs are refreshed only while a managed project is open; browser fallback retains existing JSON/File System behavior and has no synthetic job panel.

## 5. 验收标准

| ID | 验收 |
|---|---|
| AC-1 | `listImportJobs` returns deterministic active-first/recent-terminal bounded summaries and redacts staging/draft/runtime references. |
| AC-2 | The new fixed IPC/preload API is trusted-frame guarded; no generic bridge, schema or storage-owner change occurs, and capability count is 13. |
| AC-3 | R10 materialization observer sees request → polling transitions → terminal result without changing legacy no-observer or direct-import fallback behavior. |
| AC-4 | Opening a managed project, saving, recovery polling, refresh and cancellation produce truthful UI state; running cancel remains request-only. |
| AC-5 | UI shows active/recent job status, progress, error and bounded recovery context; browser fallback does not expose an unusable panel. |
| AC-6 | Remote foundation, typecheck, production full check and exact source/doc read-back pass. |

## 6. 风险与回退

- A recovered job can finish before the panel first polls; recent terminal summaries make the outcome visible, but no event stream is claimed.
- A list response can race with job transition; next bounded poll is the authority. UI never fabricates progress or terminal state.
- `cancelImportJob` cannot safely interrupt an already-promoted filesystem commit; the panel labels it as a request and observes the next snapshot.
- A save may still fail after an asset job completes but before document write; R10 transaction boundary remains explicitly unchanged.

## 7. 实现与验证证据（2026-09-22）

### 7.1 实现

- `AssetImportController.listJobs()` 复用既有 in-memory rehydrated journal，不读出 repository internals；固定 `MAX_LISTED_IMPORT_JOBS = 25`，active FIFO 优先、recent terminal 补足。snapshot 仅包含 safe id/name/status/progress/error/result/timestamps；`displayName` 会去除 caller text 中的 `/` 或 `\` path segments，绝不返回 draft、originalName、staging hash/path 或 bytes。
- `ProjectStorageController` 增加 `listImportJobs()`；`main.cjs` / `preload.cjs` / `ArtflowStorageApi` 增加同名 no-argument fixed task。它仍通过 `assertTrustedRenderer`，没有 generic IPC、schema 或 repository ownership 改动。fixed capability 总数为 **13**。
- `materializeManagedProjectDocument` 新增 optional `onImportJobUpdate` observer。它从 request snapshot 起观察去重后的 queued/running/completed transition，带 one-based asset ordinal；observer 异常不会改变 R10 materialization。无 observer 的 existing caller 和 R5 direct-import fallback 保持兼容。
- `useFileSystem` 以 project epoch 拒绝旧 project poll result，只在 managed project open 时 refresh / poll active summary；save observer 驱动当前进度，existing `cancelImportJob` 的返回 snapshot 进入 UI state。`ImportJobsPanel` 只在 managed bridge available 时从 TopBar 打开，显示 bounded status/error/progress 和 truthful cancel-request note。

### 7.2 验收结果

| 验收 | 结果 / 证据 |
|---|---|
| AC-1 | 通过：remote foundation 构造 2 active + 30 terminal records，验证 active-first、recent-terminal order、25 cap、basename display 与 `draft` / `stagingHash` / `originalName` / path/hash redaction；真实 `ProjectStorageController` summary 也验证 timestamps 与 completed managed result。 |
| AC-2 | 通过：foundation 静态验证 `listImportJobs` preload/main fixed channel、trusted sender handler，且 main/preload `artflow-storage:` capability count 均为 13；没有 schema migration。 |
| AC-3 | 通过：durable materializer mock observer 精确收到 `queued → running → completed`，每个 update 为 `renderer-image, 1/1`；原 no-observer legacy direct-import fixture 和真实 R9 bridge 继续通过。 |
| AC-4 / AC-5 | 通过：foundation 验证 hook epoch / refresh / cancel seam、panel wiring、running cancellation disclosure 与 browser-safe conditional render；Vite production build 成功纳入新 panel。该轮不伪造 event stream、retry 或 atomic document recovery。 |
| AC-6 | 通过：remote `npm --prefix artflow run typecheck`、`check:foundations` 与 full `check` 全部 exit 0；final 19/19 R18 source/governance exact read-back SHA-256 matched。full check 的 Vite build 处理 2,087 modules；仅保留既有 >500 kB chunk warning 与 Node SQLite ExperimentalWarning。 |

## 8. 完成边界

R18 makes existing durable import work observable and usable; it is not a general job platform. A future FDD is required for retry, project transaction recovery, batch ingestion, automatic node placement, background parser/thumbnail services, retention/GC or multi-window queue ownership.
