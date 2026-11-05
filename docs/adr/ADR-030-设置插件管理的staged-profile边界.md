# ADR-030：设置插件管理采用 staged profile，而非 runtime hot-reload

- **状态**：accepted（verified）
- **日期**：2026-09-22
- **关联**：FDD-030、现有 `plugins/profile.ts`、`plugins/loader.ts`

## Context

Builtin plugin manifests、user profile patches 和 reversible disposers 已存在，但 profile 仅在 renderer startup 中解析。当前没有运行期 plugin lifecycle controller，也没有安全的方式在 React tree 正在使用 contribution、service 或 card component 时原地卸载并重建它们。直接在 Settings toggle 内 hot-disable would leave stale materialized card maps, services, callbacks and UI references possible.

The requested Settings management experience still needs to be useful: users must inspect what is loaded, change a preference, understand when it takes effect, and recover from invalid choices without a new storage owner.

## Decision

1. Add a generic `settings_sections` contribution slot and `ui.settings` manifest capability. The Settings host renders sections by generic contract; `builtin.ui-plugin-manager` is a normal manifest-loaded builtin contribution rather than an App-specific tab.
2. Add a generic `PLUGIN_PROFILE_MANAGER_SERVICE`. It receives validated manifests, the actual startup profile, `Storage`, a reload callback and a narrow protected-id set. It writes only the existing `artflow.profile.patch.v1` user layer and always resolves the candidate profile before persistence.
3. Enable/disable is **staged**. The panel shows active profile state separately from pending profile state, and calls `window.location.reload()` only after an explicit user action. Startup’s existing profile-filtered loader remains the only activation authority.
4. Preserve non-enabled config patches when reset removes enabled overrides. A protected bootstrap manager cannot disable itself through its own only recovery UI; the startup entrypoint supplies this policy without putting builtin IDs into generic profile mechanics.
5. Keep the initial scope builtin-only. No install/update/uninstall/external execution, marketplace, filesystem discovery, runtime reload or project persistence enters R30.

## Consequences

- Users get a visible Settings-based control surface and can safely stage the profile behavior that already existed but was hidden.
- The system remains truthful: a toggle does not falsely claim to remove code from the current renderer session.
- A single reload is the transaction boundary; it clears React/contribution references naturally and reuses well-tested startup validation.
- `settings_sections` becomes reusable for later Settings extensions without CanvasSettings gaining per-plugin conditions.
- The protected recovery rule is intentionally narrow and must remain documented; it is not a general priority class nor a Runtime Core loophole.

## Rejected alternatives

- **Hardcode a Plugins tab in `CanvasSettings`**: violates the project’s UI contribution rule and makes host UI own plugin-specific business.
- **Reuse Extensions / `ui_panels` only**: does not meet the user-requested Settings location and conflates extension content with profile administration.
- **Hot activate/deactivate through existing loader disposer**: reversible registration alone is insufficient to safely remount all renderer consumers; it needs its own lifecycle/controller FDD.
- **Create a new plugin database/project field**: duplicates the existing user profile patch and would unnecessarily couple a global preference to project documents.
- **Add marketplace/install/update now**: expands trust, filesystem, signature and external runtime boundaries far beyond a builtin inventory/settings vertical.

## Verification record

2026-09-22：remote `typecheck`、`check:foundations` 和 full production `check` 均 exit 0。Foundation validates staged profile mutation/rejection/recovery, the real manifest-loaded Settings section lifecycle and generic source boundaries. Canonical selected source/governance/package read-back SHA-256 values match staging; no dependency or lockfile changed.
