import { mergeImportedConfig } from '../../compatibility/apply.ts'
import { SYNC_DEFAULT } from '../../defaults.ts'

import { syncWithBookmarks } from '../links/model.ts'

import type { SyncSnapshot } from '../../../types/sync.ts'

// Pure transformation used by the download path. Exposed (and kept in this
// import-light module) so tests can assert the "incoming overwrites local,
// deletions propagate" contract without pulling in DOM-touching modules.
//
// Important: the remote snapshot is the single source of truth on download. We do NOT
// dedupe here — if the remote stored two identical URLs (e.g. because Chrome
// itself had two duplicate bookmarks), they must round-trip back unchanged.
export function computeDownloadedSync(incoming: Partial<SyncSnapshot>): SyncSnapshot {
    return syncWithBookmarks(mergeImportedConfig(structuredClone(SYNC_DEFAULT), incoming))
}
