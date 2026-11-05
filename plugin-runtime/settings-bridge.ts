/**
 * settings-bridge.ts —— 设置面板状态桥（CanvasSettings 宿主 ↔ settings_sections 插件组件）。
 * 与 workspace.ui-bridge 同构：宿主每次 render 原地更新（ref 突变），插件组件经
 * kernel.use 读取当前值与 setter。provide 必须发生在首帧渲染期间（useEffect 时序会炸）。
 */
import type { Hotkey, PresentationHotkeys, WheelAction } from '../types';
import type { UiLanguage } from './i18n';
import { DEFAULT_CANVAS_BACKGROUND } from './ui-theme-settings';

export interface SettingsUiBridge {
  general: {
    apiKey: string;
    setApiKey: (value: string) => void;
    language: UiLanguage;
    setLanguage: (lang: UiLanguage) => void;
  };
  appearance: {
    available: boolean;
    openThemeStudio: () => void;
  };
  hotkeys: {
    wheelAction: WheelAction;
    setWheelAction: (action: WheelAction) => void;
    generateHotkey: Hotkey;
    setGenerateHotkey: (hotkey: Hotkey) => void;
    presentationHotkeys: PresentationHotkeys;
    setPresentationHotkeys: (hotkeys: PresentationHotkeys) => void;
  };
  canvas: {
    canvasBackgroundColor: string;
    onCanvasBackgroundColorChange: (color: string) => void;
    onCanvasBackgroundImageChange: (file: File) => void;
  };
}

export const SETTINGS_UI_BRIDGE_SERVICE = 'settings.ui-bridge';

export const createSettingsUiBridge = (): SettingsUiBridge =>
  ({
    general: {
      apiKey: '',
      setApiKey: () => {},
      language: 'zho',
      setLanguage: () => {},
    },
    appearance: {
      available: false,
      openThemeStudio: () => {},
    },
    hotkeys: {
      wheelAction: 'zoom',
      setWheelAction: () => {},
      generateHotkey: { key: 'Enter', metaOrCtrlKey: true, shiftKey: false, altKey: false },
      setGenerateHotkey: () => {},
      presentationHotkeys: {
        nextSmooth: { key: 'ArrowRight', metaOrCtrlKey: false, shiftKey: false, altKey: false },
        prevSmooth: { key: 'ArrowLeft', metaOrCtrlKey: false, shiftKey: false, altKey: false },
        nextDirect: { key: 'ArrowDown', metaOrCtrlKey: false, shiftKey: false, altKey: false },
        prevDirect: { key: 'ArrowUp', metaOrCtrlKey: false, shiftKey: false, altKey: false },
      },
      setPresentationHotkeys: () => {},
    },
    canvas: {
      canvasBackgroundColor: DEFAULT_CANVAS_BACKGROUND,
      onCanvasBackgroundColorChange: () => {},
      onCanvasBackgroundImageChange: () => {},
    },
  }) as SettingsUiBridge;
