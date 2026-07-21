import React from 'react';

export default function PageLoader() {
  return (
    <div className="animate-pulse space-y-6 p-4">
      {/* Header skeleton */}
      <div className="flex items-center justify-between">
        <div className="h-8 w-48 bg-gray-800 rounded-lg" />
        <div className="h-9 w-28 bg-gray-800 rounded-lg" />
      </div>

      {/* Stat cards skeleton */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-28 bg-gray-800/60 rounded-xl border border-gray-700/40 p-4 space-y-3">
            <div className="h-4 w-20 bg-gray-700 rounded" />
            <div className="h-7 w-16 bg-gray-700 rounded" />
            <div className="h-3 w-32 bg-gray-700/60 rounded" />
          </div>
        ))}
      </div>

      {/* Table skeleton */}
      <div className="bg-gray-800/40 rounded-xl border border-gray-700/30 overflow-hidden">
        <div className="h-11 bg-gray-800/60 border-b border-gray-700/30 px-4 flex items-center gap-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-3 w-20 bg-gray-700 rounded" />
          ))}
        </div>
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-14 border-b border-gray-700/20 px-4 flex items-center gap-4">
            {[...Array(5)].map((_, j) => (
              <div key={j} className="h-3 w-20 bg-gray-700/50 rounded" />
            ))}
          </div>
        ))}
      </div>

      {/* Floating indicator */}
      <div className="fixed bottom-6 right-6 flex items-center gap-2 bg-gray-900/90 border border-blue-500/30 text-blue-300 text-xs px-3 py-2 rounded-full backdrop-blur-sm">
        <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Loading chunk…
      </div>
    </div>
  );
}
