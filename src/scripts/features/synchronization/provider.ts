import { fetchGistUpdatedAt, findGistId, retrieveGist, sendGist, setGistStatus, setGistStatusNow } from './gist.ts'

import type { Local, RemoteProviderKind } from '../../../types/local.ts'
import type { Sync } from '../../../types/sync.ts'

export interface RemoteMetadata {
    provider: RemoteProviderKind
    resourceId: string
    updatedAt: string
}

export interface RemoteSnapshot {
    metadata: RemoteMetadata
    sync: Sync
}

export interface RemoteProvider {
    kind: RemoteProviderKind
    isEnabled: (local: Local) => boolean
    isAuthorized: (local: Local) => boolean
    getResourceId: (local: Local) => string | undefined
    getLastSyncedAt: (local: Local) => string | undefined
    getLastFetchedAt: (local: Local) => string | undefined
    fetchedPatch: (fetchedAt: string) => Partial<Local>
    syncedPatch: (metadata: RemoteMetadata) => Partial<Local>
    clearPatch: () => (keyof Local)[]
    findResource: (local: Local) => Promise<string | undefined>
    fetchUpdatedAt: (local: Local) => Promise<string | undefined>
    download: (local: Local) => Promise<RemoteSnapshot>
    upload: (local: Local, data: Sync) => Promise<RemoteMetadata>
    setStatus: (local?: Local) => void
    setStatusNow: (metadata?: RemoteMetadata) => void
}

export function getRemoteProvider(local?: Local): RemoteProvider | undefined {
    switch (local?.syncType) {
        case 'gist':
            return gistProvider
        default:
            return undefined
    }
}

export const gistProvider: RemoteProvider = {
    kind: 'gist',

    isEnabled(local: Local): boolean {
        return local.syncType === 'gist'
    },

    isAuthorized(local: Local): boolean {
        return !!local.gistToken
    },

    getResourceId(local: Local): string | undefined {
        return local.remoteResourceId
    },

    getLastSyncedAt(local: Local): string | undefined {
        return local.remoteLastSyncedAt
    },

    getLastFetchedAt(local: Local): string | undefined {
        return local.remoteLastFetchedAt
    },

    fetchedPatch(fetchedAt: string): Partial<Local> {
        return {
            remoteLastFetchedAt: fetchedAt,
        }
    },

    syncedPatch(metadata: RemoteMetadata): Partial<Local> {
        return {
            remoteResourceId: metadata.resourceId,
            remoteLastSyncedAt: metadata.updatedAt,
            localConfigUpdatedAt: metadata.updatedAt,
        }
    },

    clearPatch(): (keyof Local)[] {
        return [
            'remoteResourceId',
            'remoteLastSyncedAt',
            'remoteLastFetchedAt',
            'lastSyncedPayload',
        ]
    },

    async findResource(local: Local): Promise<string | undefined> {
        return await findGistId(local.gistToken)
    },

    async fetchUpdatedAt(local: Local): Promise<string | undefined> {
        const id = this.getResourceId(local)
        if (!id) {
            return
        }
        return await fetchGistUpdatedAt(local.gistToken ?? '', id)
    },

    async download(local: Local): Promise<RemoteSnapshot> {
        const resourceId = this.getResourceId(local)
        const result = await retrieveGist(local.gistToken ?? '', resourceId)

        return {
            metadata: {
                provider: 'gist',
                resourceId: resourceId ?? '',
                updatedAt: result.updatedAt,
            },
            sync: result.sync,
        }
    },

    async upload(local: Local, data: Sync): Promise<RemoteMetadata> {
        const result = await sendGist(local.gistToken ?? '', this.getResourceId(local), data)

        return {
            provider: 'gist',
            resourceId: result.id,
            updatedAt: result.updatedAt,
        }
    },

    setStatus(local?: Local): void {
        void setGistStatus(local?.gistToken, local ? this.getResourceId(local) : undefined).catch((err) => {
            console.warn('Cannot refresh GitHub synchronization status', err)
        })
    },

    setStatusNow(metadata?: RemoteMetadata): void {
        setGistStatusNow(metadata?.resourceId, metadata?.updatedAt)
    },
}
