/**
 * Node task cancellation IPC handlers.
 */
import { abortNodeTasks, abortNodeTasksAndWait, nodeCancellationError } from './ipcUtils.js';
import electronPkg from 'electron';
const { ipcMain } = electronPkg;

export function registerNetworkHandlers({ ipcMainInstance = ipcMain } = {}) {
  // Add direct listener for node task cancellation
  ipcMainInstance.on('cancel-node-task', (event, nodeId, cause = null, manualAiRunIds = []) => {
    // `cause` is the renderer's own account of WHY (Reset / cleared files /
    // board clear / node deleted). Without it the main process could only see
    // the generic sentinel and reported every user Reset as "Node deleted".
    if (nodeId) {
      abortNodeTasks(nodeId, event.sender, nodeCancellationError(cause), {
        manualAiRunIds: typeof manualAiRunIds === 'string' ? [manualAiRunIds] : manualAiRunIds,
      });
    }
  });

  // Transactional cancellation needs acknowledgement that the
  // aborted handler has reached its own finally/sidecar-cleanup boundary before
  // the shared queue lane is released. This handler is deliberately not wrapped
  // in handleSafe, otherwise it would register—and abort—itself under `nodeId`.
  ipcMainInstance.handle('cancel-node-task-and-wait', async (event, { nodeId, cause = null, manualAiRunId = null, manualAiRunIds = [] } = {}) => {
    if (!nodeId) return { abortedCount: 0, settled: true };
    return abortNodeTasksAndWait(nodeId, event.sender, nodeCancellationError(cause), 30_000, {
      manualAiRunIds: [manualAiRunId, ...(Array.isArray(manualAiRunIds) ? manualAiRunIds : [])],
    });
  });
}
