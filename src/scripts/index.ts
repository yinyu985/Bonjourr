import { darkmode, favicon, tabTitle, textShadow } from './features/others.ts'
import { synchronization } from './features/synchronization/index.ts'
import { backgroundsInit } from './features/backgrounds/index.ts'
import { customFont } from './features/fonts.ts'
import { quickLinks } from './features/links/index.ts'
import { customCss } from './features/css.ts'
import { clock } from './features/clock/index.ts'
import { notes } from './features/notes.ts'
import './features/contextmenu.ts'

import { displayInterface, onInterfaceDisplay } from './shared/display.ts'
import { setTranslationCache, traduction } from './utils/translations.ts'
import { settingsNotifications } from './utils/notifications.ts'
import { operaExtensionExplainer } from './startup/opera.ts'
import { setPotatoComputerMode } from './startup/potato.ts'
import { userDate } from './shared/time.ts'
import { onlineAndMobile } from './startup/online.ts'
import { serviceWorker } from './startup/serviceworker.ts'
import { settingsInit } from './settings.ts'
import { userActions } from './events.ts'
import { storage } from './storage.ts'

import { BROWSER, PLATFORM, SYSTEM_OS } from './defaults.ts'

restoreBackgroundCache()

// storage 写失败时显示 settings 顶部的 banner（永久显示直到用户重启或下次成功）。
// 对应触发：localStorage 配额满、Safari 私密模式 quota=0、扩展存储被禁等。
globalThis.addEventListener('bonjourr-storage-error', () => {
    settingsNotifications({ 'storage-error': true })
})

function restoreBackgroundCache(): void {
    const src = localStorage.getItem('backgroundCache')
    if (src) {
        const wrapper = document.getElementById('background-wrapper')
        const media = document.getElementById('background-media')
        if (wrapper && media) {
            const div = document.createElement('div')
            div.className = 'background-image'
            div.style.backgroundImage = `url(${src})`
            media.appendChild(div)
            wrapper.style.opacity = '1'
            wrapper.classList.remove('hidden')
        }
    }
}

try {
    const startupPromise = startup()
    serviceWorker()
    onlineAndMobile()
    startupPromise.catch((err) => {
        console.warn('Startup failed', err)
    })
} catch (err) {
    console.warn('Startup failed', err)
}

async function startup(): Promise<void> {
    const { sync, local } = await storage.init()

    await setTranslationCache(sync.lang, local)

    displayInterface(undefined, sync)
    traduction(null, sync.lang)
    userDate(sync.clock.timezone)
    customFont(sync.font)
    textShadow(sync.textShadow)
    favicon(sync.favicon)
    tabTitle(sync.tabtitle)
    clock(sync)
    darkmode(sync.dark)
    customCss(sync.css)
    backgroundsInit(sync, local, true)
    quickLinks({ sync, local })
    notes(sync)
    synchronization(local)
    settingsInit(sync, local)
    operaExtensionExplainer(local.operaExplained)

    document.documentElement.dataset.system = SYSTEM_OS as string
    document.documentElement.dataset.browser = BROWSER as string
    document.documentElement.dataset.platform = PLATFORM as string

    document.getElementById('time')?.classList.toggle('hidden', !sync.time)
    document.getElementById('linkblocks')?.classList.toggle('hidden', !sync.links.enabled)
    onInterfaceDisplay(() => {
        document.body.classList.remove('init')

        setPotatoComputerMode()
        userActions()
    })
}
