

import React from 'react';

interface LoaderProps {
    progressMessage: string;
}

export const Loader: React.FC<LoaderProps> = ({ progressMessage }) => {
    return (
        <div className="absolute bottom-4 right-4 z-50 flex items-center space-x-2">
             <div data-bp-ui-surface="" className="w-auto h-10 px-4 py-2 bg-[var(--ui-bg-color)] backdrop-blur-xl border border-white/10 rounded-full flex items-center justify-center space-x-3">
                <svg className="animate-spin h-6 w-6 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span className="text-white text-sm">{progressMessage || 'Generating...'}</span>
            </div>
        </div>
    );
};