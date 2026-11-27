function toFileArray(files) {
  if (!files) return [];
  return Array.isArray(files) ? files : Array.from(files);
}

function defaultPathResolver(file) {
  return globalThis.window?.electronAPI?.getPathForFile?.(file) || '';
}

function getLocalFilePath(file, pathResolver = defaultPathResolver) {
  if (!file) return '';
  const directPath = file.path || file.filePath || '';
  if (typeof directPath === 'string' && directPath.trim()) return directPath.trim();

  try {
    const resolved = pathResolver?.(file) || '';
    return typeof resolved === 'string' ? resolved.trim() : '';
  } catch {
    return '';
  }
}

function getFileDisplayName(file, path) {
  const name = file?.name || file?.filename || '';
  if (typeof name === 'string' && name.trim()) return name.trim();
  return path.split(/[\\/]/).pop() || '';
}

export function filesToDropPayloads(files, pathResolver = defaultPathResolver) {
  return toFileArray(files)
    .map(file => {
      const path = getLocalFilePath(file, pathResolver);
      return {
        name: getFileDisplayName(file, path),
        type: file?.type || '',
        size: file?.size || 0,
        path,
      };
    })
    .filter(file => file.path);
}
