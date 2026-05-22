import { GlobalRegistrator } from '@happy-dom/global-registrator'
import 'fake-indexeddb/auto'

GlobalRegistrator.register({
    url: 'http://localhost:3000',
    width: 1,
    height: 1,
})

// 几个 feature 模块在顶层就抓 DOM 节点（`document.getElementById('linkblocks')`
// 等等）并 addEventListener；只要任何测试间接 import 到这些模块，没有这些骨架
// 元素就会在加载阶段抛 null。这里塞一份最小骨架让模块加载不炸——具体功能
// 测试该自己再补 DOM。
document.body.innerHTML = `
    <div id="linkblocks"></div>
    <div id="link-mini"></div>
`

// storage 的 type 模块级缓存默认是 'webext-local'；只有调用过 storage.type.init()
// 才会在缺少 chrome.storage 时切到 'localstorage'。集成测试经常直接用 storage.sync.*
// 不先 init，否则会撞上 `chrome is not defined`。这里集中处理一次。
const { storage } = await import('../src/scripts/storage.ts')
storage.type.init()

// Happy DOM schedules a short initialization timer. Let it settle before Deno
// starts tests that use the shared document, otherwise leak detection can
// attribute that timer to the first sanitized test in the next test module.
await new Promise((resolve) => setTimeout(resolve, 0))
