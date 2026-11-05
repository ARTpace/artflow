/**
 * useWorkspaceLayout.ts —— 把 React 状态挂到 `workspace` 卷上（跨重启保持）。
 *
 * 抽成 hook 的理由：App.tsx 里有 6 处面板开合状态，若每处都手写
 * "useState(读卷) + useEffect(写卷) + try/catch" 就是 6 份复制粘贴；
 * 而这类复制粘贴一旦有一处漏了 `catch`，那个面板就变成了"改了不保存"的哑状态。
 *
 * 一条刻意的行为：**只在值真的变了时才写**（比对"上次已提交的值"）。
 * 两个坑都要避开：
 *  - 若无条件写，"从没动过布局的用户"也会在磁盘上留下一整套默认值，
 *    "用户真选过的布局"和"默认值"从此分不开；且 StrictMode 会把 effect 跑两遍。
 *  - 若拿"首次渲染的值"当基线，用户**改回原值**时反而漏写（内存 false、磁盘 true）。
 * 维护"上次已提交的值"两个坑都没有。
 */

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { workspaceVolume } from '../plugin-runtime/workspace-layout';

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

export const useWorkspaceState = <T,>(
  key: string,
  fallback: T,
  isValid?: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] => {
  const [value, setValue] = useState<T>(() => {
    const stored = workspaceVolume.peek(key);
    if (stored === undefined) return fallback;
    if (isValid) return isValid(stored) ? stored : fallback;
    return stored as T;
  });

  /** 已经和磁盘一致的值。初始等于本次读到的值 —— 于是"没改过"天然不触发写入。 */
  const lastCommitted = useRef(value);
  useEffect(() => {
    if (sameValue(lastCommitted.current, value)) return;
    try {
      workspaceVolume.write(key, value);
      // 写失败时不更新，下次值变化会再试一次（而不是把失败当成已提交）。
      lastCommitted.current = value;
    } catch (error) {
      // 写盘失败不该冒泡成 React 渲染错误；真实原因由主进程写进 logs/electron.log，
      // 也会体现在设置页的"存储管理"面板上（degraded）。
      console.error(`[workspace] 布局保存失败：${key}`, error);
    }
  }, [key, value]);

  return [value, setValue];
};

export const useWorkspaceFlag = (
  key: string,
  fallback: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] =>
  useWorkspaceState(key, fallback, (value): value is boolean => typeof value === 'boolean');
