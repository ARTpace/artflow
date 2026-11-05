/**
 * Narrow renderer-local capability offered by App to workspace command plugins.
 * It is intentionally a named service instead of an App import or generic command RPC.
 */

export const WORKSPACE_COMMAND_ACTIONS_SERVICE = 'workspace.command-actions';

export interface WorkspaceCommandActions {
  fitCanvas(): void;
  canFitCanvas(): boolean;
  openCanvasFinder(): void;
  openSavedViews(): void;
  openExtensions(): void;
  canOpenExtensions(): boolean;
}
