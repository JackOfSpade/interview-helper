import React from 'react';
import { Download } from 'lucide-react';
import { downloadPercent, formatBytes } from './callModel.js';

export default function DownloadingScreen({ download }) {
  const percent = downloadPercent(download);
  // Before the server says how big the files are there is nothing to count yet ("0 MB of 0 MB").
  const known = Number(download?.totalBytes) > 0;
  return <main className="flex min-h-screen items-center justify-center bg-[#202124] p-4 text-violet-50" aria-label="Downloading call files">
    <section className="w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-[#2d2e30] p-5 shadow-xl shadow-black/30">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-violet-50"><Download size={16} aria-hidden="true" />Downloading call files</h1>
        <p className="text-[13px] text-white/65">This only happens once. Your interview setup carries on as soon as it’s done.</p>
      </header>
      <div role="progressbar" aria-label="Model download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-violet-400/80 transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-[12px] tabular-nums text-white/55">{known ? `${percent}% · ${formatBytes(download?.receivedBytes)} of ${formatBytes(download?.totalBytes)}` : 'Starting the download…'}</p>
    </section>
  </main>;
}
