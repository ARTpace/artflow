import React, { useEffect, useRef } from 'react';
import { Element } from '../types';

interface EditingOverlayProps {
  zoom: number;
  editingElement: { id: string; text: string } | null;
  elements: Element[];
  setEditingElement: (val: { id: string; text: string } | null) => void;
  handleStopEditing: () => void;
  setElements: (elements: Element[] | ((prev: Element[]) => Element[]), commit?: boolean) => void;
}

export const EditingOverlay: React.FC<EditingOverlayProps> = ({
  zoom,
  editingElement,
  elements,
  setEditingElement,
  handleStopEditing,
  setElements,
}) => {
  const editingTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editingInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingElement) {
      const element = elements.find(el => el.id === editingElement.id);
      setTimeout(() => {
        if (element?.type === 'text' && editingTextareaRef.current) {
          editingTextareaRef.current.focus();
          editingTextareaRef.current.select();
        } else if (element?.type === 'frame' && editingInputRef.current) {
          editingInputRef.current.focus();
          editingInputRef.current.select();
        }
      }, 0);
    }
  }, [editingElement, elements]);

  useEffect(() => {
    if (editingElement && editingTextareaRef.current) {
      const textarea = editingTextareaRef.current;
      textarea.style.height = 'auto';
      const newHeight = textarea.scrollHeight;
      textarea.style.height = '';

      const currentElement = elements.find(el => el.id === editingElement.id);
      if (currentElement && currentElement.type === 'text' && currentElement.height !== newHeight) {
        setElements(prev => prev.map(el =>
          el.id === editingElement.id && el.type === 'text'
            ? { ...el, height: newHeight }
            : el
        ), false);
      }
    }
  }, [editingElement?.text, elements, setElements]);

  if (!editingElement) return null;

  const element = elements.find(el => el.id === editingElement.id);
  if (!element) return null;

  if (element.type === 'text') {
    return (
      <foreignObject
        x={element.x - (2 / zoom)}
        y={element.y - (2 / zoom)}
        width={element.width + (4 / zoom)}
        height={element.height + (4 / zoom)}
        style={{ overflow: 'visible' }}
      >
        <textarea
          ref={editingTextareaRef}
          value={editingElement.text}
          onChange={e => setEditingElement({ ...editingElement, text: e.target.value })}
          onBlur={handleStopEditing}
          style={{
            width: `${element.width}px`,
            fontSize: `${element.fontSize}px`,
            color: element.fontColor,
            lineHeight: 1.2,
            border: `${2 / zoom}px solid #3b82f6`,
            outline: 'none',
            padding: 0,
            margin: 0,
            background: 'transparent',
            resize: 'none',
            overflow: 'hidden'
          }}
        />
      </foreignObject>
    );
  } else if (element.type === 'frame') {
    return (
      <foreignObject
        x={element.x + (8 / zoom)}
        y={element.y - (8 / zoom) - (16 / zoom)}
        width={200 / zoom}
        height={24 / zoom}
        style={{ overflow: 'visible', pointerEvents: 'all' }}
      >
        <input
          ref={editingInputRef}
          type="text"
          value={editingElement.text}
          onChange={e => setEditingElement({ ...editingElement, text: e.target.value })}
          onBlur={handleStopEditing}
          onKeyDown={(e) => e.key === 'Enter' && handleStopEditing()}
          style={{
            fontSize: `${16 / zoom}px`,
            background: 'var(--bp-canvas-bg, #111827)',
            color: 'white',
            border: `1px solid #3b82f6`,
            borderRadius: `${4 / zoom}px`,
            padding: `${4 / zoom}px`,
            width: '100%',
            height: '100%',
            outline: 'none',
          }}
        />
      </foreignObject>
    );
  }

  return null;
};
