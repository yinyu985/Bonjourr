import './init.test.ts'

import { assertEquals, assertNotEquals } from '@std/assert'
import { storage } from '../src/scripts/storage.ts'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'
import { __testing } from '../src/scripts/features/synchronization/index.ts'
import { getConfigSnapshots } from '../src/scripts/features/synchronization/backup.ts'

import type { Sync } from '../src/types/sync.ts'

const { applyDownloadedSync, syncPayloadHash } = __testing
const SNAPSHOTS_KEY = 'bonjourr-config-snapshots'

// 这一组测试是为了挡住几次踩过的同步坑：
//   - syncPayloadHash 对 notes 内容必须敏感（曾经被 stringify replacer 过滤掉过）
//   - selectedFolder 切换不算"内容变更"（避免每切个文件夹都上传一次 Gist）
//   - applyDownloadedSync 真的把远端没有的字段删干净（删除会跨设备传播）
//   - 同步成功后归档快照立刻清掉（防止占满 5MB localStorage 配额）

// ---- syncPayloadHash ----

Deno.test({
    name: 'syncPayloadHash changes when a note body is edited',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const before = syncWithNote('hello')
        const after = syncWithNote('hello world')

        assertNotEquals(syncPayloadHash(before), syncPayloadHash(after))
    },
})

Deno.test({
    name: 'syncPayloadHash changes when a note title is edited',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const before = syncWithNote('body', 'Title A')
        const after = syncWithNote('body', 'Title B')

        assertNotEquals(syncPayloadHash(before), syncPayloadHash(after))
    },
})

Deno.test({
    name: 'syncPayloadHash ignores selectedFolder so navigation does not trigger uploads',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const a = structuredClone(SYNC_DEFAULT)
        const b = structuredClone(SYNC_DEFAULT)
        b.links.selectedFolder = 'something-else'

        assertEquals(syncPayloadHash(a), syncPayloadHash(b))
    },
})

Deno.test({
    name: 'syncPayloadHash changes when a link is added',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const a = structuredClone(SYNC_DEFAULT)
        const b = structuredClone(SYNC_DEFAULT)
        b.links.folders[0].items.push({
            id: 'links0001',
            title: 'New',
            url: 'https://example.com',
        })

        assertNotEquals(syncPayloadHash(a), syncPayloadHash(b))
    },
})

// ---- applyDownloadedSync ----

Deno.test({
    name: 'applyDownloadedSync persists the incoming config and drops local-only keys',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await storage.sync.clear()
        localStorage.removeItem(SNAPSHOTS_KEY)

        const current = structuredClone(SYNC_DEFAULT)
        current.lang = 'fr'
        current.tabtitle = 'local-only-tab-title'
        await storage.sync.set(current)

        const incoming: Partial<Sync> = structuredClone(SYNC_DEFAULT)
        incoming.lang = 'ja'

        const next = await applyDownloadedSync(current, incoming)
        const saved = await storage.sync.get()

        assertEquals(next.lang, 'ja')
        assertEquals(saved.lang, 'ja')
        assertEquals(saved.tabtitle, SYNC_DEFAULT.tabtitle)
    },
})

Deno.test({
    name: 'applyDownloadedSync saves a snapshot before overwriting',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await storage.sync.clear()
        localStorage.removeItem(SNAPSHOTS_KEY)

        const current = structuredClone(SYNC_DEFAULT)
        current.lang = 'fr'
        await storage.sync.set(current)

        const incoming = structuredClone(SYNC_DEFAULT)
        incoming.lang = 'ja'

        await applyDownloadedSync(current, incoming)

        const snapshots = getConfigSnapshots()
        assertEquals(snapshots.length, 1)
        assertEquals(snapshots[0].reason, 'sync-download')
        assertEquals(snapshots[0].config.lang, 'fr')
    },
})

Deno.test({
    name: 'syncPayloadHash is stable for the post-sync sync (no upload loop)',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await storage.sync.clear()
        localStorage.removeItem(SNAPSHOTS_KEY)
        const current = structuredClone(SYNC_DEFAULT)
        const incoming = structuredClone(SYNC_DEFAULT)
        incoming.lang = 'de'

        const next = await applyDownloadedSync(current, incoming)
        const saved = await storage.sync.get()

        assertEquals(syncPayloadHash(next), syncPayloadHash(saved))
    },
})

// ---- helpers ----

function syncWithNote(content: string, title = 'Untitled'): Sync {
    const data = structuredClone(SYNC_DEFAULT)
    data.notes = {
        active: 'note-1',
        records: [{
            id: 'note-1',
            title,
            content,
            updatedAt: '2026-01-01T00:00:00.000Z',
        }],
    }
    return data
}
