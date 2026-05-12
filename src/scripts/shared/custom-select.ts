let initializedCloseHandler = false
const refreshBySelect = new WeakMap<HTMLSelectElement, () => void>()

export function initCustomSelects(root: ParentNode = document): void {
    const selects = root.querySelectorAll<HTMLSelectElement>('select:not([data-custom-select])')

    for (const select of selects) {
        select.dataset.customSelect = 'true'
        select.classList.add('custom-select-native')

        const custom = document.createElement('div')
        const button = document.createElement('button')
        const list = document.createElement('div')

        custom.className = 'custom-select'
        button.className = 'custom-select-button'
        button.type = 'button'
        button.setAttribute('aria-haspopup', 'listbox')
        list.className = 'custom-select-options'
        list.setAttribute('role', 'listbox')

        if (select.closest('#contextmenu')) {
            list.classList.add('contextmenu-options')
        }

        custom.append(button)
        select.after(custom)
        document.body.append(list)

        const refresh = (): void => {
            const selected = select.selectedOptions[0] ?? select.options[0]
            button.textContent = selected?.textContent ?? ''
            list.replaceChildren()

            for (const option of select.options) {
                if (option.disabled || option.hidden || option.classList.contains('hidden')) {
                    continue
                }

                const optionButton = document.createElement('button')
                optionButton.type = 'button'
                optionButton.textContent = option.textContent
                optionButton.dataset.value = option.value
                optionButton.classList.toggle('selected', option.value === select.value)
                optionButton.setAttribute('role', 'option')
                optionButton.setAttribute('aria-selected', String(option.value === select.value))

                optionButton.addEventListener('click', () => {
                    select.value = option.value
                    select.dispatchEvent(new Event('input', { bubbles: true }))
                    select.dispatchEvent(new Event('change', { bubbles: true }))
                    closeCustomSelects()
                    refresh()
                })

                list.append(optionButton)
            }
        }

        refreshBySelect.set(select, refresh)

        const positionList = (): void => {
            const rect = button.getBoundingClientRect()
            const spaceBelow = globalThis.innerHeight - rect.bottom - 8
            const spaceAbove = rect.top - 8
            const openAbove = spaceBelow < 160 && spaceAbove > spaceBelow
            const maxHeight = Math.max(120, Math.floor(openAbove ? spaceAbove : spaceBelow))
            const optionHeight = 28
            const verticalPadding = 8
            const listHeight = Math.min(maxHeight, list.children.length * optionHeight + verticalPadding)

            list.style.position = 'fixed'
            list.style.left = `${rect.left}px`
            list.style.minWidth = `${rect.width}px`
            list.style.height = listHeight === maxHeight ? `${maxHeight}px` : ''
            list.style.maxHeight = `${maxHeight}px`

            if (openAbove) {
                list.style.top = ''
                list.style.bottom = `${globalThis.innerHeight - rect.top + 4}px`
            } else {
                list.style.top = `${rect.bottom + 4}px`
                list.style.bottom = ''
            }
        }

        button.addEventListener('click', () => {
            const willOpen = !custom.classList.contains('open')
            closeCustomSelects()

            if (willOpen) {
                select.dispatchEvent(new Event('focus'))
            }

            refresh()
            if (willOpen) {
                positionList()
            }
            custom.classList.toggle('open', willOpen)
            list.classList.toggle('open', willOpen)
        })

        button.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeCustomSelects()
            }

            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                button.click()
            }
        })

        select.addEventListener('change', refresh)
        refresh()
    }

    if (!initializedCloseHandler) {
        initializedCloseHandler = true

        document.addEventListener('pointerdown', (event) => {
            const target = event.target as HTMLElement

            if (!target.closest('.custom-select') && !target.closest('.custom-select-options')) {
                closeCustomSelects()
            }
        })

        const aside = document.getElementById('settings')
        aside?.addEventListener('scroll', closeCustomSelects, { passive: true })
        globalThis.addEventListener('resize', closeCustomSelects)
    }
}

export function refreshCustomSelects(root: ParentNode = document): void {
    const selects = root.querySelectorAll<HTMLSelectElement>('select[data-custom-select]')

    for (const select of selects) {
        const custom = select.nextElementSibling

        if (!(custom instanceof HTMLElement) || !custom.classList.contains('custom-select')) {
            continue
        }

        refreshBySelect.get(select)?.()
    }
}

function closeCustomSelects(): void {
    for (const select of document.querySelectorAll('.custom-select.open')) {
        select.classList.remove('open')
    }

    for (const list of document.querySelectorAll('.custom-select-options.open')) {
        list.classList.remove('open')
    }
}
