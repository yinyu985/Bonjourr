import type { Backgrounds } from '../../../types/sync.ts'
import type { Background } from '../../../types/shared.ts'

export function toggleCredits(backgrounds: Backgrounds): void {
    const container = document.getElementById('background-credit')

    if (!container) {
        return
    }

    container.classList.toggle('shown', backgrounds.type === 'images')
}

export function updateCredits(image?: Background): void {
    const el = document.getElementById('credit-text')

    if (!el || !image?.page || !image?.username) {
        return
    }

    const author = image.name || image.username
    const city = image.city || ''
    const country = image.country || ''
    const comma = city && country ? ', ' : ''
    const location = `${city}${comma}${country}`
    const text = [author, location].filter(Boolean).join(' · ')

    const link = document.createElement('a')
    link.textContent = text

    if (image.page.includes('unsplash')) {
        link.href = `https://unsplash.com/@${image.username}?utm_source=Bonjourr&utm_medium=referral`
    } else {
        link.href = image.page
    }

    link.target = '_blank'
    link.rel = 'noopener noreferrer'

    el.textContent = ''
    el.appendChild(link)
}
