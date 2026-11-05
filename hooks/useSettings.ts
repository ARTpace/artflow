
import { useState, useEffect, useCallback } from 'react';
import { trySkinEngine } from '../plugin-runtime/skin-engine';
import type { UserEffect, Hotkey, PresentationHotkeys, ImageAspectRatio, WheelAction } from '../types';
import { readSecret, writeSecret } from '../plugin-runtime/secrets-store';
import { getPreference, peekPreference, setPreference } from '../plugin-runtime/preferences-store';
import { setLanguage as persistLanguage, useTranslation } from '../utils/language-store';

/** 敏感数据（API key）的密钥卷键名；后端是主进程 userData/config/secrets.json。 */
const GEMINI_API_KEY_SECRET = 'ai.geminiApiKey';

/** 偏好卷键名：后端是主进程 userData/config/preferences.json，与 origin 无关。 */
const WHEEL_ACTION_KEY = 'input.wheelAction';
const USER_EFFECTS_KEY = 'canvas.userEffects';
const GENERATE_HOTKEY_KEY = 'input.generateHotkey';
const PRESENTATION_HOTKEYS_KEY = 'input.presentationHotkeys';

const DEFAULT_GENERATE_HOTKEY: Hotkey = {
    key: 'Enter',
    metaOrCtrlKey: true,
    shiftKey: false,
    altKey: false,
};

const DEFAULT_PRESENTATION_HOTKEYS: PresentationHotkeys = {
    nextSmooth: { key: 'ArrowDown', metaOrCtrlKey: false, shiftKey: false, altKey: false },
    prevSmooth: { key: 'ArrowUp', metaOrCtrlKey: false, shiftKey: false, altKey: false },
    nextDirect: { key: 'ArrowRight', metaOrCtrlKey: false, shiftKey: false, altKey: false },
    prevDirect: { key: 'ArrowLeft', metaOrCtrlKey: false, shiftKey: false, altKey: false },
};

/** 快捷键是用户手改的 JSON，读回来必须当不可信输入校验 —— 半截对象会让按键裁决链崩掉。 */
const readHotkey = <T extends object>(key: string, fallback: T, isValid: (value: unknown) => value is T): T => {
    const stored = peekPreference(key);
    return isValid(stored) ? stored : fallback;
};

const isHotkey = (value: unknown): value is Hotkey => {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<Hotkey>;
    return typeof candidate.key === 'string'
        && typeof candidate.metaOrCtrlKey === 'boolean'
        && typeof candidate.shiftKey === 'boolean'
        && typeof candidate.altKey === 'boolean';
};

const isPresentationHotkeys = (value: unknown): value is PresentationHotkeys => {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<PresentationHotkeys>;
    return isHotkey(candidate.nextSmooth) && isHotkey(candidate.prevSmooth)
        && isHotkey(candidate.nextDirect) && isHotkey(candidate.prevDirect);
};

export const useSettings = () => {
    // 语言不再由本 hook 私有持有：utils/language-store 是单一真相，本体组件（TopBar /
    // BoardPanel / CanvasNavigator / cards/*）与插件 UI 都直接订阅它，避免到处透传 props。
    // 持久化由该 store 负责（后端是主进程 config/preferences.json），这里不再重复写盘。
    // t 同样来自 store（复用 translations 表），不再在本 hook 内重复一份实现。
    const { language, t } = useTranslation();
    const setLanguage = persistLanguage;

    // The skin engine is the ONLY writer of visual settings, including toolbar side.
    // Keep this bridge read-only for the workspace while a theme preview is active.
    const [toolbarPosition, setToolbarPosition] = useState<'left' | 'right'>(
        () => trySkinEngine()?.getUiSettings().toolbarSide ?? 'left',
    );
    useEffect(() => {
        const engine = trySkinEngine();
        if (!engine) return;
        const sync = (side: 'left' | 'right') => setToolbarPosition(previous => previous === side ? previous : side);
        sync(engine.getUiSettings().toolbarSide);
        return engine.subscribeUiSettings(settings => sync(settings.toolbarSide));
    }, []);
    
    // 密钥不再落 localStorage（明文 + 按 origin 隔离，换启动方式就要重填）。
    // 现走 plugins/secrets-store：后端是主进程 userData/config/secrets.json，
    // 旧的 localStorage['geminiApiKey'] 由该 store 一次性采纳（旧值不删）。
    const [apiKey, setApiKey] = useState<string>(() => {
        try {
            return readSecret(GEMINI_API_KEY_SECRET) || process.env.API_KEY || '';
        } catch (e) {
            console.error("Failed to load API key from secret store", e);
            return process.env.API_KEY || '';
        }
    });
    
    // 以下四项的持久化都从 localStorage 搬到了 `plugins/preferences-store`
    // （后端 userData/config/preferences.json）。旧键由该 store 一次性采纳，旧值不删。
    // 注意：快捷键改为**同步初始化** —— 原来"先默认值、再 effect 读盘"会让首帧拿到
    // 默认键位，用户自定义的键在首帧失效（按下没反应），是个真实可感的小 bug。
    const [wheelAction, setWheelAction] = useState<WheelAction>(() => {
        const stored = getPreference<string>(WHEEL_ACTION_KEY, 'zoom');
        return stored === 'zoom' || stored === 'pan' ? stored : 'zoom';
    });

    const [userEffects, setUserEffects] = useState<UserEffect[]>(() => {
        const stored = peekPreference(USER_EFFECTS_KEY);
        return Array.isArray(stored) ? (stored as unknown as UserEffect[]) : [];
    });

    const [generateHotkey, setGenerateHotkey] = useState<Hotkey>(() =>
        readHotkey(GENERATE_HOTKEY_KEY, DEFAULT_GENERATE_HOTKEY, isHotkey));

    const [presentationHotkeys, setPresentationHotkeys] = useState<PresentationHotkeys>(() =>
        readHotkey(PRESENTATION_HOTKEYS_KEY, DEFAULT_PRESENTATION_HOTKEYS, isPresentationHotkeys));

    const [generationMode, setGenerationMode] = useState<'image' | 'video'>('image');
    const [videoAspectRatio, setVideoAspectRatio] = useState<'16:9' | '9:16'>('16:9');
    const [imageAspectRatio, setImageAspectRatio] = useState<ImageAspectRatio>('1:1');
    const [numberOfImages, setNumberOfImages] = useState<number>(1);
    const [numberOfVideos, setNumberOfVideos] = useState<number>(1);

    useEffect(() => {
        try {
            writeSecret(GEMINI_API_KEY_SECRET, apiKey);
        } catch (e) {
            console.error("Failed to save API key to secret store", e);
        }
    }, [apiKey]);

    // 写盘一律经 preferences-store（失败会同步抛出）。这里 catch 住只是不让写盘异常
    // 冒泡成 React 渲染错误；真正的落盘失败原因会由主进程写进 logs/electron.log。
    useEffect(() => {
        try { setPreference(WHEEL_ACTION_KEY, wheelAction); }
        catch (e) { console.error("Failed to save wheel action", e); }
    }, [wheelAction]);

    useEffect(() => {
        try { setPreference(USER_EFFECTS_KEY, userEffects); }
        catch (e) { console.error("Failed to save user effects", e); }
    }, [userEffects]);

    useEffect(() => {
        try { setPreference(GENERATE_HOTKEY_KEY, generateHotkey); }
        catch (e) { console.error("Failed to save generate hotkey", e); }
    }, [generateHotkey]);

    useEffect(() => {
        try { setPreference(PRESENTATION_HOTKEYS_KEY, presentationHotkeys); }
        catch (e) { console.error("Failed to save presentation hotkeys", e); }
    }, [presentationHotkeys]);

    const handleAddUserEffect = useCallback((effect: UserEffect) => {
        setUserEffects(prev => [...prev, effect]);
    }, []);

    const handleDeleteUserEffect = useCallback((id: string) => {
        setUserEffects(prev => prev.filter(effect => effect.id !== id));
    }, []);

    return {
        language,
        setLanguage,
        toolbarPosition,
        apiKey,
        setApiKey,
        wheelAction,
        setWheelAction,
        userEffects,
        setUserEffects,
        generationMode,
        setGenerationMode,
        videoAspectRatio,
        setVideoAspectRatio,
        imageAspectRatio,
        setImageAspectRatio,
        numberOfImages,
        setNumberOfImages,
        numberOfVideos,
        setNumberOfVideos,
        generateHotkey,
        setGenerateHotkey,
        presentationHotkeys,
        setPresentationHotkeys,
        handleAddUserEffect,
        handleDeleteUserEffect,
        t,
    };
};
