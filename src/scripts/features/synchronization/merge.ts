import { isElem, isSubfolder } from '../links/model.ts'
import { randomString } from '../../shared/generic.ts'

import type { LinkElem, LinkNode } from '../../../types/shared.ts'
import type { Sync } from '../../../types/sync.ts'

export function mergeSyncAppend(current: Sync, incoming: Sync): Sync {
    const merged = structuredClone(current)
    const groupIds = new Set(merged.links.folders.map((group) => group.id))

    for (const group of incoming.links.folders) {
        if (groupIds.has(group.id)) {
            const target = merged.links.folders.find((item) => item.id === group.id)
            if (target) {
                mergeItems(target.items, group.items)
            }
        } else {
            const clone = structuredClone(group)
            clone.source = 'local'
            localizeNodeIds(clone.items)
            merged.links.folders.push(clone)
            groupIds.add(clone.id)
        }
    }

    mergeFavorites(merged, incoming.links.favorites)

    if (!merged.links.folders.some((group) => group.id === merged.links.selectedFolder)) {
        merged.links.selectedFolder = merged.links.folders[0]?.id ?? 'default'
    }

    return dedupeSyncLinks(merged)
}

export function dedupeSyncLinks(data: Sync): Sync {
    for (const group of data.links.folders) {
        dedupeItems(group.items)
    }

    data.links.favorites = uniqueLinks(data.links.favorites)

    return data
}

function mergeItems(target: LinkNode[], incoming: LinkNode[]): void {
    const folderByTitle = new Map(target.filter(isSubfolder).map((folder) => [folder.title, folder]))
    const urls = new Set(target.filter(isElem).map((link) => normalizeUrl(link.url)))

    for (const item of incoming) {
        if (isElem(item)) {
            const url = normalizeUrl(item.url)
            if (urls.has(url)) continue

            const clone = structuredClone(item)
            clone.id = uniqueNodeId(target)
            target.push(clone)
            urls.add(url)
            continue
        }

        const existing = folderByTitle.get(item.title)
        if (existing) {
            mergeItems(existing.items, item.items)
        } else {
            const clone = structuredClone(item)
            localizeNodeIds(clone.items)
            clone.id = uniqueNodeId(target)
            target.push(clone)
            folderByTitle.set(clone.title, clone)
        }
    }
}

function mergeFavorites(data: Sync, incoming: LinkElem[]): void {
    const urls = new Set(data.links.favorites.map((link) => normalizeUrl(link.url)))

    for (const item of incoming) {
        const url = normalizeUrl(item.url)
        if (urls.has(url)) continue

        const clone = structuredClone(item)
        clone.id = uniqueNodeId(data.links.favorites)
        data.links.favorites.push(clone)
        urls.add(url)
    }
}

function dedupeItems(items: LinkNode[]): void {
    const urls = new Set<string>()

    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]

        if (isSubfolder(item)) {
            dedupeItems(item.items)
            continue
        }

        const url = normalizeUrl(item.url)
        if (urls.has(url)) {
            items.splice(i, 1)
        } else {
            urls.add(url)
        }
    }
}

function uniqueLinks(links: LinkElem[]): LinkElem[] {
    const urls = new Set<string>()
    const result: LinkElem[] = []

    for (const link of links) {
        const url = normalizeUrl(link.url)
        if (urls.has(url)) continue

        urls.add(url)
        result.push(link)
    }

    return result
}

function localizeNodeIds(items: LinkNode[]): void {
    const usedIds = new Set<string>()

    for (const item of items) {
        if (isSubfolder(item)) {
            localizeNodeIds(item.items)
        }

        item.id = uniqueNodeId([...items, ...[...usedIds].map((id) => ({ id }))])
        usedIds.add(item.id)
    }
}

function uniqueNodeId(items: { id: string }[]): string {
    const ids = new Set(items.map((item) => item.id))
    let id = `links${randomString(6)}`

    while (ids.has(id)) {
        id = `links${randomString(6)}`
    }

    return id
}

function normalizeUrl(url: string): string {
    return url.trim()
}
