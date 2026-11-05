import React from 'react';

interface CanvasCardShellProps {
    children?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    draggable?: boolean;
    variant?: 'default' | 'media';
    [attribute: `data-${string}`]: string | number | boolean | undefined;
    header: React.ReactNode;
    actions?: React.ReactNode;
    decoration?: React.ReactNode;
    footer?: React.ReactNode;
    headerClassName?: string;
    headerStyle?: React.CSSProperties;
    actionsClassName?: string;
    contentClassName?: string;
    contentStyle?: React.CSSProperties;
    /** Interactive media consumes canvas gestures; passive cards remain draggable. */
    interactiveContent?: boolean;
}

const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation();
const stopDragEvents = {
    onPointerDown: stopPropagation,
    onMouseDown: stopPropagation,
    onTouchStart: stopPropagation,
};

/** Shared chrome only: card-specific content and lifecycle stay with the caller. */
export function CanvasCardShell({
    header, actions, decoration, footer, children,
    className = '', style, variant = 'default', headerClassName = '', headerStyle,
    actionsClassName = '', contentClassName = 'flex-1 min-h-0 relative', contentStyle, interactiveContent = false,
    ...rootProps
}: CanvasCardShellProps) {
    return (
        <div {...rootProps} data-canvas-card-shell
            className={`w-full h-full flex flex-col overflow-hidden border select-none ${variant === 'media' ? 'relative ' : ''}${className}`}
            style={{ background: 'var(--bp-card-bg, #18181b)', color: 'var(--bp-text-primary, #fff)', borderColor: 'var(--bp-border, #444)', ...style }}>
            {decoration}
            {/* ponytail: only media opts into overlay chrome; passive card layout stays unchanged. */}
            <div data-card-header className={`flex items-center gap-2 ${variant === 'media' ? 'absolute top-2 left-2 right-2 z-10 pointer-events-none ' : ''}${headerClassName}`} style={headerStyle}>
                {header}
                {actions && <div data-card-actions className={actionsClassName} {...stopDragEvents}
                    {...(variant === 'media' ? { onDoubleClick: stopPropagation, onKeyDown: stopPropagation, onKeyUp: stopPropagation } : {})}>{actions}</div>}
            </div>
            <div data-card-content className={contentClassName} style={contentStyle}
                {...(interactiveContent ? {
                    ...stopDragEvents,
                    onDoubleClick: stopPropagation, onWheel: stopPropagation,
                    onKeyDown: stopPropagation, onKeyUp: stopPropagation,
                } : {})}>
                {children}
            </div>
            {footer}
        </div>
    );
}
