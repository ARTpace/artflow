/**
 * plugin-error-boundary.tsx —— 插件挂载点的通用局部错误边界（宿主通用件，不含任何业务知识）。
 *
 * 动机：全仓此前只有 index.tsx 的根级 RootErrorBoundary。任一插件贡献的组件在渲染期抛错，
 * 异常会沿 React 树一路冒泡到根边界，把整页替换成错误页（并丢掉未保存的编辑）。
 * 插件贡献经 `kernel.contributions` 注册时必带 pluginId，宿主在挂载点就能把它透传下来，
 * 因此"把某个贡献的渲染隔离成局部失败 + 占位里点出 pluginId"不需要第三方插件配合。
 *
 * 用法（宿主侧一律传 slot + pluginId，可选 label 便于定位）：
 *   <PluginErrorBoundary slot="ui_panels" pluginId={panel.pluginId} label={panel.id}>
 *     <PanelComponent ... />
 *   </PluginErrorBoundary>
 *
 * 能力边界（必须写清，避免误以为包上它就万事大吉）：
 *   - 只捕获渲染期同步抛出的异常（render / 构造函数 / 生命周期）；
 *   - **不**捕获事件回调（onClick 等）与异步回调中的异常 —— 宿主各自的 try/catch 兜底
 *     （见 ContextMenu 的 item.run、宿主取文案时的 label()/title() 解析）；
 *   - **不**捕获同步死循环、未处理的 Promise 拒绝（那属于沙箱/进程级问题）。
 */
import React from 'react';
import { useLanguage } from '../utils/language-store';
import type { UiLanguage } from './i18n';

/** 统一的插件失败上报：槽位 + 插件 ID + 阶段，便于把一条日志直接定位到具体插件。 */
export const reportPluginFailure = (
  slot: string,
  pluginId: string | null | undefined,
  phase: string,
  error: unknown,
): void => {
  console.error(`[plugin-boundary] ${slot} ${phase} failed (plugin=${pluginId || 'unknown'})`, error);
};

export interface PluginErrorBoundaryProps {
  /** 贡献槽位名：ui_panels / canvas_node_types / canvas_overlays / ui_toolbar / canvas_widgets / settings_sections / ui_menus / ui_menus 之外的宿主取文案点。 */
  slot: string;
  /** 贡献归属插件 ID（Contribution.pluginId）；缺省时占位显示 unknown。 */
  pluginId?: string | null;
  /** 贡献 ID / 展示名，仅用于占位文案定位（可缺省）。 */
  label?: string;
  /** 占位文案语言；缺省跟随全局语言开关。 */
  language?: UiLanguage;
  /** 画布卡片等有固定外框的场景：占位撑满容器。 */
  fill?: boolean;
  /** 占位最小高度（px 或 CSS 值）；无固定外框时给它一个可见高度。 */
  minHeight?: number | string;
  children?: React.ReactNode;
}

interface PluginErrorBoundaryState {
  error: Error | null;
}

/**
 * 类实现（错误边界必须是类组件）。本工程未安装 @types/react，
 * `React.Component` 在类型层近似 any —— 显式声明用到的字段即可，同 index.tsx 的 RootErrorBoundary。
 */
class PluginErrorBoundaryImpl extends React.Component<PluginErrorBoundaryProps, PluginErrorBoundaryState> {
  // 无初始化器 ⇒ 不产生运行时赋值，this.props 仍由 React 在构造期写入。
  props: PluginErrorBoundaryProps;
  state: PluginErrorBoundaryState = { error: null };
  /** 同 props/state：@types/react 缺席时显式声明用到的 Component 成员（运行时由 React 原型提供）。 */
  setState: (state: Partial<PluginErrorBoundaryState>) => void;

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    reportPluginFailure(this.props.slot, this.props.pluginId, 'render', error);
    if (info?.componentStack) {
      console.error(`[plugin-boundary] ${this.props.slot} component stack:${info.componentStack}`);
    }
  }

  /** 局部重试：只重置本边界，不触碰其他挂载点。 */
  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { slot, pluginId, label, fill, minHeight } = this.props;
    const zho = (this.props.language ?? 'zho') === 'zho';
    const owner = pluginId || (zho ? '未知插件（未登记 pluginId）' : 'unknown plugin (no pluginId registered)');
    return (
      <div
        role="alert"
        data-bp-plugin-boundary=""
        data-bp-plugin-slot={slot}
        data-bp-plugin-id={pluginId || 'unknown'}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          width: fill ? '100%' : undefined,
          height: fill ? '100%' : undefined,
          minHeight,
          boxSizing: 'border-box',
          padding: '10px 12px',
          border: '1px dashed rgba(248,113,113,0.55)',
          borderRadius: 10,
          background: 'rgba(127,29,29,0.20)',
          color: 'var(--bp-ui-text, #f4f4f5)',
          fontSize: 12,
          lineHeight: 1.5,
          overflow: 'auto',
        }}
      >
        <span style={{ fontWeight: 600 }}>
          {zho ? '插件组件渲染失败（已局部降级）' : 'Plugin component failed to render (degraded locally)'}
        </span>
        <span style={{ opacity: 0.8, wordBreak: 'break-all' }}>
          {`plugin: ${owner} · slot: ${slot}${label ? ` · ${label}` : ''}`}
        </span>
        <pre
          style={{
            margin: 0,
            maxHeight: 96,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 11,
            opacity: 0.75,
          }}
        >
          {error.message}
        </pre>
        <span style={{ opacity: 0.65 }}>
          {zho
            ? '仅此组件不可用，其余界面（画布、未保存编辑）不受影响。'
            : 'Only this component is unavailable; the rest of the UI (canvas, unsaved edits) keeps working.'}
        </span>
        <button
          type="button"
          onClick={this.reset}
          style={{
            alignSelf: 'flex-start',
            padding: '3px 10px',
            borderRadius: 6,
            border: '1px solid rgba(248,113,113,0.65)',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          {zho ? '重试' : 'Retry'}
        </button>
      </div>
    );
  }
}

/**
 * 宿主统一入口：函数壳只负责订阅全局语言（类组件不能用 hooks），错误状态由类实现持有。
 * 语言显式传入时以传入值为准（宿主已有 language prop 的场景），否则跟随全局语言开关。
 */
export const PluginErrorBoundary: React.FC<PluginErrorBoundaryProps> = ({ language, ...rest }) => {
  const current = useLanguage();
  return <PluginErrorBoundaryImpl {...rest} language={language ?? current} />;
};
