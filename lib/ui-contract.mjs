/** Testable settings information architecture; Client factory follows this exact order. */
export const SETTINGS_SECTIONS = Object.freeze(['connection', 'bindings', 'input', 'output', 'media', 'model', 'security', 'diagnostics'])
export const PICKER_OPTIONS = Object.freeze({ allowedTypes: ['session'], multiple: false, allowMixed: false, allowParentChild: false, allowCreateSession: true, selectModel: true })
export function selectedBinding(row, result) {
  if (result?.status !== 'selected' || result.items?.length !== 1 || result.items[0].type !== 'session') return row
  const item = result.items[0]
  // Changing a previously used route requires a new identity; IO forbids recipient rebinding after delivery.
  const { id: oldId, ...rest } = row
  return { ...rest, sessionId: item.sessionId, workspaceId: item.workspaceId, label: item.title || row.label, enabled: false, sendEnabled: false, ...(result.modelSelection ? { modelSelection: result.modelSelection, modelPolicy: 'binding-once', modelRevision: (row.modelRevision ?? 0) + 1 } : {}) }
}
