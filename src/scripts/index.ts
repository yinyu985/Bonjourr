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
import { operaExtensionExplainer } from './startup/opera.ts'
import { setPotatoComputerMode } from './startup/potato.ts'
import { userDate } from './shared/time.ts'
import { onlineAndMobile } from './startup/online.ts'
import { serviceWorker } from './startup/serviceworker.ts'
import { tabsTracking } from './startup/tabstracking.ts'
import { settingsInit } from './settings.ts'
import { userActions } from './events.ts'
import { filterData } from './compatibility/apply.ts'
import { storage } from './storage.ts'

import { BROWSER, CURRENT_VERSION, LOCAL_DEFAULT, PLATFORM, SYNC_DEFAULT, SYSTEM_OS } from './defaults.ts'

restoreBackgroundCache()

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
    let { sync, local } = await storage.init()
    const oldVersion = sync?.about?.version

    if (!sync || !local) {
        console.warn('Storage failed, loading Bonjourr with default settings')
        sync = structuredClone(SYNC_DEFAULT)
        local = structuredClone(LOCAL_DEFAULT)
    }

    if (oldVersion !== CURRENT_VERSION) {
        console.info(`Updated Bonjourr, ${oldVersion} => ${CURRENT_VERSION}`)

        localStorage.setItem('update-archive', JSON.stringify(sync))

        sync = filterData('update', sync)

        local.translations = undefined
        storage.local.remove('translations')
        local = { ...LOCAL_DEFAULT, ...local }

        // <!> keep this order
        // <!> must delete old keys before upgrading storage
        await storage.sync.clear()
        await storage.sync.set(sync)
    }

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
    tabsTracking()

    document.documentElement.dataset.system = SYSTEM_OS as string
    document.documentElement.dataset.browser = BROWSER as string
    document.documentElement.dataset.platform = PLATFORM as string

    document.getElementById('time')?.classList.toggle('hidden', !sync.time)
    document.getElementById('linkblocks')?.classList.toggle('hidden', !sync.quicklinks)
    onInterfaceDisplay(() => {
        document.body.classList.remove('init')

        setPotatoComputerMode()
        userActions()
    })
}
