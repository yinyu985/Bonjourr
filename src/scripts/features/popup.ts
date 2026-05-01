import { tradThis } from '../utils/translations.ts'
import { BROWSER } from '../defaults.ts'
import { storage } from '../storage.ts'

type PopupInit = {
    old?: string
    new: string
    review: number
    announce: 'major' | 'off'
}

type PopupUpdate = {
    announcements?: boolean
}

const ANNOUNCEMENT_URL = 'https://github.com/victrme/Bonjourr/releases'

const ANNOUNCEMENT_TEXT =
    '<b>Bonjourr just got a major update! ✨</b> Discover the cleaner minimalist layout, improved links, refreshed design, and more.'

const REVIEW_TEXT = 'Love using Bonjourr? Consider giving us a review or donating, that would help a lot! 😇'
const REVIEW_URLS = {
    chrome:
        'https://chrome.google.com/webstore/detail/bonjourr-%C2%B7-minimalist-lig/dlnejlppicbjfcfcedcflplfjajinajd/reviews',
    opera:
        'https://chrome.google.com/webstore/detail/bonjourr-%C2%B7-minimalist-lig/dlnejlppicbjfcfcedcflplfjajinajd/reviews',
    firefox: 'https://addons.mozilla.org/en-US/firefox/addon/bonjourr-startpage/',
    safari: 'https://apps.apple.com/fr/app/bonjourr-startpage/id1615431236',
    edge: 'https://microsoftedge.microsoft.com/addons/detail/bonjourr/dehmmlejmefjphdeoagelkpaoolicmid',
    other: 'https://bonjourr.fr/help#%EF%B8%8F-reviews',
}

export function interfacePopup(init?: PopupInit, event?: PopupUpdate): void {
    // // force popup for debugging
    // displayPopup('announce', true)
    // displayPopup('review', true)

    if (event?.announcements !== undefined) {
        storage.sync.set({ announcements: event.announcements ? 'major' : 'off' })
        return
    }

    // Announcements

    if (!init || init?.announce === 'off') {
        return
    }

    if (init.old && init.review === -1) {
        const major = (s: string) => Number.parseInt(s.split('.')[0])
        const isMajorUpdate = major(init.new) > major(init.old)

        const announceMajor = init.announce === 'major' && isMajorUpdate
        const canAnnounce = localStorage.hasUpdated === 'true' || announceMajor

        if (canAnnounce) {
            localStorage.hasUpdated = 'true'
            displayPopup('announce', true)
            return
        }
    }

    // Reviews

    if (init.review === -1) {
        return
    }

    const reviewCounter = parseInt(localStorage.reviewCounter ?? '0')

    if (reviewCounter > 30) {
        displayPopup('review')
        return
    }

    localStorage.reviewCounter = reviewCounter + 1
}

function displayPopup(type: 'review' | 'announce', showIcon = false): void {
    const template = document.getElementById('popup-template') as HTMLTemplateElement
    const doc = document.importNode(template.content, true)
    const popup = doc.getElementById('popup')
    const desc = doc.getElementById('popup_desc') as HTMLElement
    const close = doc.getElementById('popup_close') as HTMLElement
    const buttons = doc.getElementById('popup_buttons') as HTMLElement

    if (!popup) {
        return
    }

    if (type === 'review') {
        desc.textContent = tradThis(REVIEW_TEXT)
        buttons.appendChild(createPopupButton(REVIEW_URLS[BROWSER], tradThis('Review')))
        buttons.appendChild(createPopupButton('https://ko-fi.com/bonjourr', tradThis('Donate')))
    }

    if (type === 'announce') {
        const buttontext = `${tradThis('Read the blog post')} 📝`
        desc.innerHTML = ANNOUNCEMENT_TEXT
        buttons.appendChild(createPopupButton(ANNOUNCEMENT_URL, buttontext))
    }

    close?.addEventListener('click', closePopup)
    document.body.appendChild(popup)
    popup.classList.add(type)
    popup.classList.toggle('withIcon', showIcon)
    openPopup()
}

function createPopupButton(href: string, text: string): HTMLAnchorElement {
    const anchor = document.createElement('a')

    anchor.href = href
    anchor.rel = 'noreferrer'
    anchor.textContent = text
    anchor.addEventListener('pointerdown', removePopupTrigger)

    return anchor
}

//

function removePopupTrigger(): void {
    storage.sync.set({ review: -1 })
    localStorage.removeItem('reviewCounter')
    localStorage.removeItem('hasUpdated')
}

function openPopup(): void {
    setTimeout(() => document.getElementById('popup')?.classList.add('shown'), 800)
    setTimeout(() => document.getElementById('credit-container')?.setAttribute('style', 'opacity: 0'), 400)
}

function closePopup(): void {
    setTimeout(() => document.getElementById('popup')?.remove(), 200)
    setTimeout(() => document.getElementById('credit-container')?.removeAttribute('style'), 600)
    document.getElementById('popup')?.classList.remove('shown')
    removePopupTrigger()
}
