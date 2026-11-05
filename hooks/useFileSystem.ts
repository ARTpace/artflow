import { useState, useCallback, useEffect, useRef } from 'react';
import type { Board, ManagedImportJob } from '../types';
import { serializeProjectDocument } from '../utils/projectDocument';
import {
    hasManagedProjectStorage,
    materializeManagedProjectDocument,
    type ManagedImportJobUpdate,
} from '../utils/managedProjectStorage';

const ACTIVE_IMPORT_STATUSES = new Set<ManagedImportJob['status']>(['queued', 'running']);
const IMPORT_JOB_POLL_INTERVAL_MS = 750;
const MAX_VISIBLE_IMPORT_JOBS = 25;

const orderImportJobs = (jobs: readonly ManagedImportJob[]): ManagedImportJob[] => {
    const active = jobs.filter(job => ACTIVE_IMPORT_STATUSES.has(job.status))
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
    const terminal = jobs.filter(job => !ACTIVE_IMPORT_STATUSES.has(job.status))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
            || (b.createdAt ?? 0) - (a.createdAt ?? 0)
            || a.id.localeCompare(b.id));
    return [...active, ...terminal].slice(0, MAX_VISIBLE_IMPORT_JOBS);
};

export const useFileSystem = () => {
    const [directoryHandle, setDirectoryHandle] = useState<any | null>(null);
    const [projectFolderName, setProjectFolderName] = useState<string | null>(null);
    const [importJobs, setImportJobs] = useState<ManagedImportJob[]>([]);
    const [currentImportProgress, setCurrentImportProgress] = useState<ManagedImportJobUpdate | null>(null);
    const [isRefreshingImportJobs, setIsRefreshingImportJobs] = useState(false);
    // Project selection changes invalidate outstanding poll responses instead of rendering a previous project's journal.
    const managedProjectEpochRef = useRef(0);

    const resetManagedImportState = useCallback(() => {
        managedProjectEpochRef.current += 1;
        setImportJobs([]);
        setCurrentImportProgress(null);
        setIsRefreshingImportJobs(false);
    }, []);

    const upsertImportJob = useCallback((nextJob: ManagedImportJob) => {
        setImportJobs(previous => orderImportJobs([nextJob, ...previous.filter(job => job.id !== nextJob.id)]));
    }, []);

    const refreshImportJobs = useCallback(async (): Promise<ManagedImportJob[]> => {
        const managedStorage = hasManagedProjectStorage() ? window.artflowStorage : undefined;
        const epoch = managedProjectEpochRef.current;
        if (!managedStorage || typeof managedStorage.listImportJobs !== 'function') {
            if (epoch === managedProjectEpochRef.current) setImportJobs([]);
            return [];
        }
        setIsRefreshingImportJobs(true);
        try {
            const jobs = orderImportJobs(await managedStorage.listImportJobs());
            if (epoch === managedProjectEpochRef.current) setImportJobs(jobs);
            return jobs;
        } finally {
            if (epoch === managedProjectEpochRef.current) setIsRefreshingImportJobs(false);
        }
    }, []);

    const requestCancelImportJob = useCallback(async (jobId: string): Promise<ManagedImportJob> => {
        const managedStorage = hasManagedProjectStorage() ? window.artflowStorage : undefined;
        if (!managedStorage || typeof managedStorage.cancelImportJob !== 'function') {
            throw new Error('Managed import cancellation is not available in this runtime');
        }
        const job = await managedStorage.cancelImportJob(jobId);
        upsertImportJob(job);
        setCurrentImportProgress(previous => previous?.job.id === job.id ? { ...previous, job } : previous);
        // The returned snapshot is authoritative for this instant; a bounded refresh observes subsequent transition.
        void refreshImportJobs().catch(error => console.warn('Failed to refresh import jobs after cancellation request:', error));
        return job;
    }, [refreshImportJobs, upsertImportJob]);

    const canObserveImportJobs = Boolean(
        projectFolderName
        && hasManagedProjectStorage()
        && typeof window.artflowStorage?.listImportJobs === 'function',
    );
    const hasActiveImportJobs = importJobs.some(job => ACTIVE_IMPORT_STATUSES.has(job.status));

    useEffect(() => () => {
        // In-flight list promises observe an epoch mismatch after unmount and cannot set stale state.
        managedProjectEpochRef.current += 1;
    }, []);

    useEffect(() => {
        if (!canObserveImportJobs) return;
        void refreshImportJobs().catch(error => console.warn('Failed to refresh durable import jobs:', error));
        if (!hasActiveImportJobs) return;
        const interval = window.setInterval(() => {
            void refreshImportJobs().catch(error => console.warn('Failed to poll durable import jobs:', error));
        }, IMPORT_JOB_POLL_INTERVAL_MS);
        return () => window.clearInterval(interval);
    }, [canObserveImportJobs, hasActiveImportJobs, projectFolderName, refreshImportJobs]);

    // Helper for legacy file upload
    const uploadFileLegacy = (): Promise<{ data: any; name: string }> => {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.style.display = 'none';
            document.body.appendChild(input);

            input.onchange = async (e: any) => {
                const file = e.target.files?.[0];
                if (!file) {
                    reject(new Error('No file selected'));
                    document.body.removeChild(input);
                    return;
                }
                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    resolve({ data, name: file.name.replace('.json', '') });
                } catch (err) {
                    reject(err);
                } finally {
                    document.body.removeChild(input);
                }
            };
            
            // Try/Catch for click in case of popup blockers
            try {
                input.click();
            } catch (e) {
                document.body.removeChild(input);
                reject(e);
            }
        });
    };

    // Helper for legacy file download
    const downloadFileLegacy = (data: any, filename: string) => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // Check for cross-origin iframes where File System Access API is typically blocked
    const isCrossOriginIframe = useCallback(() => {
        try {
            // Accessing window.top.location.href throws a SecurityError in cross-origin iframes
            return window.self !== window.top && window.top?.location.href !== window.location.href;
        } catch (e) {
            return true;
        }
    }, []);

    const restoreStartupProject = useCallback(async (): Promise<unknown | null> => {
        const managedStorage = hasManagedProjectStorage() ? window.artflowStorage : undefined;
        if (!managedStorage || typeof managedStorage.getStatus !== 'function' || typeof managedStorage.loadProject !== 'function') {
            return null;
        }
        try {
            const status = await managedStorage.getStatus();
            if (!status || !status.isOpen) return null;
            resetManagedImportState();
            setDirectoryHandle(null);
            setProjectFolderName(status.projectName);
            const document = await managedStorage.loadProject();
            void refreshImportJobs().catch(error => console.warn('Failed to read recovered import jobs:', error));
            return document;
        } catch (error) {
            console.warn('Failed to restore startup project:', error);
            return null;
        }
    }, [refreshImportJobs, resetManagedImportState]);

    const openProjectFolder = useCallback(async () => {
        const managedStorage = hasManagedProjectStorage() ? window.artflowStorage : undefined;
        if (managedStorage) {
            const selectedProject = await managedStorage.chooseProject();
            if (!selectedProject) return null;
            resetManagedImportState();
            setDirectoryHandle(null);
            setProjectFolderName(selectedProject.projectName);
            const document = await managedStorage.loadProject();
            // A list failure must not make a valid project document impossible to open.
            void refreshImportJobs().catch(error => console.warn('Failed to read recovered import jobs:', error));
            return document;
        }

        resetManagedImportState();
        // 1. Try File System Access API
        // Skip if in cross-origin iframe to avoid "SecurityError" and preserving user gesture for fallback
        if ('showDirectoryPicker' in window && !isCrossOriginIframe()) {
            try {
                // @ts-ignore
                const handle = await window.showDirectoryPicker();
                setDirectoryHandle(handle);
                setProjectFolderName(handle.name);

                try {
                    const fileHandle = await handle.getFileHandle('artflow-data.json', { create: false });
                    const file = await fileHandle.getFile();
                    const text = await file.text();
                    return JSON.parse(text);
                } catch (err) {
                    console.log("No existing artflow-data.json found in folder.");
                    return null; 
                }
            } catch (err: any) {
                if (err.name === 'AbortError') return null;
                console.warn("FileSystem API failed or blocked (likely due to permissions or iframe), falling back to legacy upload.", err);
                // Proceed to fallback
            }
        }

        // 2. Fallback to Legacy File Input
        try {
            const { data, name } = await uploadFileLegacy();
            setDirectoryHandle(null);
            setProjectFolderName(name);
            return data;
        } catch (err) {
            if ((err as Error).message !== 'No file selected') {
                console.error("Legacy file open failed:", err);
            }
            return null;
        }
    }, [isCrossOriginIframe, refreshImportJobs, resetManagedImportState]);

    /** 直接打开一个**已知路径**的工程（最近工程列表用），不弹目录对话框。 */
    const openRecentProject = useCallback(async (projectRoot: string): Promise<unknown | null> => {
        const managedStorage = hasManagedProjectStorage() ? window.artflowStorage : undefined;
        if (!managedStorage || typeof managedStorage.openRecentProject !== 'function'
            || typeof managedStorage.loadProject !== 'function') {
            return null;
        }
        // 路径已被删/无权限时主进程会 reject —— 让它冒泡给调用方，由调用方决定怎么提示；
        // 这里不吞掉，因为"点了一个灰条目还静默无反应"比报错更难排查。
        const selected = await managedStorage.openRecentProject(projectRoot);
        if (!selected) return null;
        resetManagedImportState();
        setDirectoryHandle(null);
        setProjectFolderName(selected.projectName);
        const document = await managedStorage.loadProject();
        void refreshImportJobs().catch(error => console.warn('Failed to read recovered import jobs:', error));
        return document;
    }, [refreshImportJobs, resetManagedImportState]);

    const saveProject = useCallback(async (boards: Board[]) => {
        const managedStorage = hasManagedProjectStorage() ? window.artflowStorage : undefined;
        if (managedStorage) {
            let project = await managedStorage.getStatus();
            if (!project.isOpen) {
                const selectedProject = await managedStorage.chooseProject();
                if (!selectedProject) return false;
                resetManagedImportState();
                project = selectedProject;
            }
            setDirectoryHandle(null);
            setProjectFolderName(project.projectName);
            setCurrentImportProgress(null);
            try {
                const managedDocument = await materializeManagedProjectDocument(
                    serializeProjectDocument(boards),
                    managedStorage,
                    {
                        onImportJobUpdate: update => {
                            setCurrentImportProgress(update);
                            upsertImportJob(update.job);
                        },
                    },
                );
                await managedStorage.saveProject(managedDocument);
                console.log('Managed project saved successfully.');
                return true;
            } finally {
                setCurrentImportProgress(null);
                void refreshImportJobs().catch(error => console.warn('Failed to refresh durable import jobs after save:', error));
            }
        }

        const document = serializeProjectDocument(boards);
        const serialized = JSON.stringify(document, null, 2);
        // Tauri preview has no Electron managed store: keep the legacy JSON
        // format but save through a user-mediated native dialog, not a download.
        if ('__TAURI__' in window && window.artflowApp?.saveBytes) {
            const result = await window.artflowApp.saveBytes({
                title: '保存 Artflow 工程',
                defaultName: projectFolderName ? `${projectFolderName}.json` : 'artflow-data.json',
                bytes: new TextEncoder().encode(serialized).buffer,
            });
            return result.ok;
        }
        // 1. Try writing to existing handle
        if (directoryHandle) {
            try {
                const fileHandle = await directoryHandle.getFileHandle('artflow-data.json', { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(serialized);
                await writable.close();
                console.log("Project saved successfully.");
                return true;
            } catch (err) {
                console.error("Failed to write to existing handle, falling back...", err);
            }
        }

        // 2. Try picking a directory if API available (and no handle), and not in restricted iframe
        if ('showDirectoryPicker' in window && !directoryHandle && !isCrossOriginIframe()) {
            try {
                // @ts-ignore
                const handle = await window.showDirectoryPicker();
                setDirectoryHandle(handle);
                setProjectFolderName(handle.name);
                
                const fileHandle = await handle.getFileHandle('artflow-data.json', { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(serialized);
                await writable.close();
                console.log("Project saved successfully to new folder.");
                return true;
            } catch (err: any) {
                if (err.name === 'AbortError') return false; // User cancelled
                console.warn("FileSystem API failed or blocked, falling back to download.", err);
            }
        }

        // 3. Fallback to Download
        const filename = projectFolderName ? `${projectFolderName}.json` : 'artflow-data.json';
        downloadFileLegacy(document, filename);
        return true;
    }, [directoryHandle, projectFolderName, isCrossOriginIframe, refreshImportJobs, resetManagedImportState, upsertImportJob]);

    return {
        openProjectFolder,
        openRecentProject,
        saveProject,
        restoreStartupProject,
        projectFolderName,
        isProjectOpen: !!directoryHandle || !!projectFolderName,
        // R19 uses the runtime capability for truthful UI copy; R18 job visibility remains stricter below.
        isManagedProjectStorageAvailable: hasManagedProjectStorage(),
        isManagedImportJobsAvailable: canObserveImportJobs,
        importJobs,
        currentImportProgress,
        isRefreshingImportJobs,
        refreshImportJobs,
        requestCancelImportJob,
    };
};
