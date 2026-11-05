/**
 * Narrow renderer-local capability offered by App to edit and presentation commands.
 */

export const ELEMENT_COMMAND_ACTIONS_SERVICE = 'element.command-actions';

export interface ElementCommandActions {
  undo(): void;
  redo(): void;
  copy(): void;
  deleteSelection(): void;
  canEditSelection(): boolean;
  startPresentation(): void;
  presentationNext(): void;
  presentationPrev(): void;
  exitPresentation(): void;
  isPresenting(): boolean;
}
