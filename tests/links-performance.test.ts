import './init.test.ts'

import { assertEquals, assertStrictEquals } from '@std/assert'
import { initblocks } from '../src/scripts/features/links/index.ts'
import { SYNC_DEFAULT } from '../src/scripts/defaults.ts'

import type { SyncSnapshot } from '../src/types/sync.ts'

function snapshot(title: string, url: string): SyncSnapshot {
    const sync = structuredClone(SYNC_DEFAULT)
    return {
        ...sync,
        links: {
            ...sync.links,
            enabled: true,
            selectedFolder: 'folder-one',
            folders: [{ id: 'folder-one', title: 'Folder', items: [{ id: 'link-one', title, url }] }],
            favorites: [],
        },
    }
}

Deno.test('quick links reuse indexed DOM nodes and refresh changed bookmark data', () => {
    const linkblocks = document.getElementById('linkblocks')
    const linkMini = document.getElementById('link-mini')
    linkblocks?.appendChild(linkMini!)
    document.body.insertAdjacentHTML(
        'beforeend',
        `
            <template id="link-group-template">
                <div class="link-group"><ul class="link-list"></ul><button class="link-title"></button></div>
            </template>
            <template id="link-elem-template">
                <li class="link link-elem"><a><div><img /></div><span></span></a></li>
            </template>
            <template id="link-folder-template">
                <li class="link link-folder"><div><img /></div><span></span></li>
            </template>
        `,
    )

    initblocks(snapshot('First', 'https://first.example'))
    const firstNode = document.getElementById('link-one')

    initblocks(snapshot('Changed', 'https://changed.example/path'))
    const updatedNode = document.getElementById('link-one')

    assertStrictEquals(updatedNode, firstNode)
    assertEquals(updatedNode?.querySelector('span')?.textContent, 'Changed')
    assertEquals(updatedNode?.querySelector('a')?.getAttribute('href'), 'https://changed.example/path')

    document.querySelector('#linkblocks .link-group')?.remove()
    document.getElementById('link-group-template')?.remove()
    document.getElementById('link-elem-template')?.remove()
    document.getElementById('link-folder-template')?.remove()
})
