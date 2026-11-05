/**
 * BpIcon —— 皮肤可覆盖图标组件。
 * 图标解析优先级：皮肤覆盖 > 插件注册（registerIcons）> 内置表。
 * data:/url( 值渲染 <img>，其余按 SVG inner markup 渲染（currentColor 跟随文字色）。
 */
import React, { useEffect, useState } from 'react';
import { resolveIcon, isImageIconValue, getRegisteredIcons, subscribeIcons } from '../plugin-runtime/icon-registry';
import { trySkinEngine } from '../plugin-runtime/skin-engine';

interface BpIconProps {
  name: string;
  size?: number;
  strokeWidth?: number | string;
  className?: string;
  style?: React.CSSProperties;
  /** 皮肤/注册表/内置表都没有时的兜底节点（默认渲染不出来，但保持布局占位）。 */
  fallback?: React.ReactNode;
}

export const BpIcon: React.FC<BpIconProps> = ({ name, size = 20, strokeWidth = 2, className, style, fallback = null }) => {
  const engine = trySkinEngine();
  const [skinIcons, setSkinIcons] = useState<Record<string, string>>(() => engine?.currentTokens().icons ?? {});
  const [regVersion, setRegVersion] = useState(0);

  useEffect(() => {
    if (!engine) return;
    return engine.subscribe(tokens => setSkinIcons(tokens.icons));
  }, [engine]);

  useEffect(() => subscribeIcons(() => setRegVersion(v => v + 1)), []);

  // regVersion 参与：注册表变化时强制重算合并表
  const icons = React.useMemo(
    () => ({ ...getRegisteredIcons(), ...skinIcons }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regVersion, skinIcons],
  );

  const value = resolveIcon(name, icons);
  if (!value) return <>{fallback}</>;

  if (isImageIconValue(value)) {
    const src = value.startsWith('url(') ? value.slice(4, -1).replace(/^['"]|['"]$/g, '') : value;
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        className={className}
        style={style}
        draggable={false}
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: value }}
    />
  );
};
