import type { Element } from '../types';
export const DOCUMENT_SERVICE = 'canvas.document';
export const OPERATIONS_SERVICE = 'canvas.operations';
export const DOCUMENT_PROVIDER = 'core.canvas-document';
export const MAX_OPERATION_NODES = 1000;
export interface DocumentToken { sessionId: string; boardId: string; revision: number }
export interface DocumentContext extends DocumentToken { totalNodes: number; selectionIds: readonly string[] }
export interface GeometryNode {
  id: string;
  type: Element['type'];
  parentId?: string;
  isLocked: boolean;
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  geometry: Readonly<GeometryPatch>;
}
export interface GeometryPatch { x?: number; y?: number; width?: number; height?: number; points?: readonly { x: number; y: number }[] }
export interface GeometryOperation { kind: 'node.patchGeometry'; id: string; patch: GeometryPatch }
export interface TextNodeInput { id: string; text: string; x: number; y: number; width: number; height: number; fontSize?: number; fontColor?: string; parentId?: string }
/** Declarative node schema from an installed extension package (never from request payload). */
export interface ExtensionNodeFieldSchema { type: 'string' | 'number' | 'boolean'; default: string | number | boolean }
export interface ExtensionNodeSchema {
  typeId: string;
  version: number;
  title: string;
  defaultWidth: number;
  defaultHeight: number;
  fields: Readonly<Record<string, ExtensionNodeFieldSchema>>;
  /** Ordered rename steps for stored nodes; applied lazily by the planner. */
  migrations?: readonly { from: number; to: number; rename: Readonly<Record<string, string>> }[];
}
/** Host-side resolver; only registered, enabled extension node types resolve. */
export type ExtensionSchemaProvider = (typeId: string) => ExtensionNodeSchema | undefined;
export type ExtensionScalarValue = string | number | boolean;
export interface ExtensionNodeCreateInput {
  id: string;
  typeId: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  parentId?: string;
  data?: Readonly<Record<string, ExtensionScalarValue>>;
}
export type DocumentOperation = GeometryOperation
  | { kind: 'node.createText'; node: TextNodeInput }
  | { kind: 'node.delete'; id: string }
  | { kind: 'node.reparent'; id: string; parentId: string | null }
  | { kind: 'extension.node.create'; node: ExtensionNodeCreateInput }
  | { kind: 'extension.node.update'; id: string; data: Readonly<Record<string, ExtensionScalarValue>> };
export interface OperationRequest extends DocumentToken { requestId: string; label: string; operations: readonly DocumentOperation[] }
export type DocumentErrorCode = 'INVALID_REQUEST' | 'SESSION_MISMATCH' | 'BOARD_MISMATCH' | 'CONFLICT' | 'BUSY' | 'ABORTED' | 'NOT_FOUND' | 'LIMIT_EXCEEDED' | 'REQUEST_ID_REUSED';
export class DocumentServiceError extends Error {
  constructor(readonly code: DocumentErrorCode, message: string) { super(message); this.name = 'DocumentServiceError'; }
}
export type OperationResult = Readonly<{
  status: 'applied' | 'noop' | 'rejected' | 'conflict';
  revision: number;
  requestId: string;
  actor: string;
  affectedIds: readonly string[];
  code?: DocumentErrorCode;
  message?: string;
}>;
export interface DocumentService {
  getContext(): Readonly<DocumentContext>;
  query(token: DocumentToken, options?: { offset?: number; limit?: number; ids?: readonly string[] }): readonly GeometryNode[];
  subscribe(listener: () => void): () => void;
}
export interface OperationsService { apply(request: OperationRequest): OperationResult }
