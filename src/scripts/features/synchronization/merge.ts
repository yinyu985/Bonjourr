import { isElem, isLink } from '../links/helpers.ts'
import { randomString } from '../../shared/generic.ts'

import type { Link, LinkFolder } from '../../../types/shared.ts'
import type { Sync } from '../../../types/sync.ts'

const FAVORITES_GROUP = '__favorites'

export function mergeSyncAppend(current: Sync, incoming: Sync): Sync {
    const merged = structuredClone(current)
    const sourceIdToMergedId = new Map<string, string>()
    const usedIds = new Set<string>()
    const usedUrlsByParent = new Map<string, Set<string>>()
    const folderIdentityToId = new Map<string, string>()
    const incomingGroups = incoming.linkgroups.groups.filter((group) => group !== FAVORITES_GROUP)

    for (const [key, value] of Object.entries(merged)) {
        if (isLink(value)) {
            delete merged[key]
        }
    }

    merged.linkgroups = {
        ...current.linkgroups,
        groups: uniqueStrings([...current.linkgroups.groups, ...incomingGroups]),
        pinned: uniqueStrings([...current.linkgroups.pinned, ...incoming.linkgroups.pinned]),
        synced: [...current.linkgroups.synced],
        hidden: { ...current.linkgroups.hidden },
        bookmarkFolders: { ...current.linkgroups.bookmarkFolders },
    }

    addLinks(current, 'current')
    addLinks(incoming, 'incoming')
    ensureLinkGroupsContainParents(merged)

    merged.linkgroups.pinned = merged.linkgroups.pinned.filter((group) => merged.linkgroups.groups.includes(group))
    merged.linkgroups.synced = merged.linkgroups.synced.filter((group) => merged.linkgroups.groups.includes(group))

    if (!merged.linkgroups.groups.includes(merged.linkgroups.selected)) {
        merged.linkgroups.selected = current.linkgroups.groups.includes(current.linkgroups.selected)
            ? current.linkgroups.selected
            : merged.linkgroups.groups[0] ?? 'default'
    }

    return dedupeSyncLinks(merged)

    function addLinks(source: Sync, origin: 'current' | 'incoming'): void {
        for (const link of collectLinks(source)) {
            const cloned = structuredClone(link)

            if (typeof cloned.parent === 'string' && sourceIdToMergedId.has(cloned.parent)) {
                cloned.parent = sourceIdToMergedId.get(cloned.parent)
            }

            if (isElem(cloned)) {
                if (origin === 'incoming') {
                    delete cloned.bookmark
                }

                const parentKey = linkParentKey(cloned.parent)
                const usedUrls = usedUrlsByParent.get(parentKey) ?? new Set<string>()
                const urlKey = normalizeUrl(cloned.url)

                if (usedUrls.has(urlKey)) {
                    continue
                }
                usedUrls.add(urlKey)
                usedUrlsByParent.set(parentKey, usedUrls)
            } else {
                const folderKey = folderIdentity(cloned)
                const existingId = folderIdentityToId.get(folderKey)

                if (existingId) {
                    sourceIdToMergedId.set(link._id, existingId)
                    continue
                }
            }

            if (usedIds.has(cloned._id)) {
                cloned._id = uniqueLinkId()
            }

            usedIds.add(cloned._id)
            sourceIdToMergedId.set(link._id, cloned._id)

            if (!isElem(cloned)) {
                folderIdentityToId.set(folderIdentity(cloned), cloned._id)
            }

            merged[cloned._id] = cloned
        }
    }

    function uniqueLinkId(): string {
        let id = `links${randomString(6)}`

        while (usedIds.has(id)) {
            id = `links${randomString(6)}`
        }

        return id
    }
}

export function dedupeSyncLinks(data: Sync): Sync {
    const usedUrlsByParent = new Map<string, Set<string>>()

    for (const link of collectLinks(data)) {
        if (!isElem(link)) {
            continue
        }

        const parentKey = linkParentKey(link.parent)
        const usedUrls = usedUrlsByParent.get(parentKey) ?? new Set<string>()
        const urlKey = normalizeUrl(link.url)

        if (usedUrls.has(urlKey)) {
            delete data[link._id]
            continue
        }

        usedUrls.add(urlKey)
        usedUrlsByParent.set(parentKey, usedUrls)
    }

    return data
}

function collectLinks(data: Sync): Link[] {
    return Object.values(data)
        .filter((value): value is Link => isLink(value))
        .toSorted((a, b) => {
            const folderSort = Number(isElem(a)) - Number(isElem(b))
            return folderSort || a.order - b.order
        })
}

function ensureLinkGroupsContainParents(data: Sync): void {
    for (const link of collectLinks(data)) {
        if (typeof link.parent !== 'string' || link.parent.startsWith('links')) {
            continue
        }

        if (link.parent !== FAVORITES_GROUP && !data.linkgroups.groups.includes(link.parent)) {
            data.linkgroups.groups.push(link.parent)
        }
    }
}

function folderIdentity(folder: LinkFolder): string {
    return `${folder.parent ?? ''}\n${folder.title}`
}

function normalizeUrl(url: string): string {
    return url.trim()
}

function linkParentKey(parent: unknown): string {
    return typeof parent === 'string' ? parent : ''
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))]
}
