export type PointerMouseKeyboard = PointerEvent | MouseEvent | KeyboardEvent

interface ClickdownOptions {
    propagate?: boolean
}

/**
 * Run pointer and keyboard activation without waiting for the synthetic click.
 * The following click is consumed so each user action invokes the callback once.
 */
export function onclickdown<T extends Element>(
    target: T | null,
    callback: (event: PointerMouseKeyboard, target: T) => void,
    options?: ClickdownOptions,
): void {
    if (!target) {
        throw new Error('Target is undefined')
    }

    const element = target
    const isCheckbox = element.tagName === 'INPUT' && element.getAttribute('type') === 'checkbox'
    const isLink = element.tagName === 'A'
    let activatedOnDown = false

    element.addEventListener('pointerdown', downEvent as EventListener)
    element.addEventListener('keydown', downEvent as EventListener)
    element.addEventListener('click', clickEvent as EventListener)

    function downEvent(event: PointerEvent | KeyboardEvent): void {
        const isKeydown = event.type === 'keydown'
        const code = (event as KeyboardEvent).code ?? ''
        const eventTarget = event.target as T
        const tagName = eventTarget.tagName ?? ''

        if (isKeydown && !/Space|Enter/.test(code)) return
        if (isLink && isKeydown && code === 'Space') return

        if (tagName === 'SUMMARY') {
            const details = eventTarget as unknown as HTMLDetailsElement
            details.open = !details.open
        }
        if (isCheckbox) {
            const checkbox = eventTarget as unknown as HTMLInputElement
            checkbox.checked = !checkbox.checked
        }
        if (isLink) {
            const link = eventTarget as unknown as HTMLAnchorElement
            globalThis.location.href = link.href
        }

        activatedOnDown = true
        callback(event, eventTarget)
    }

    function clickEvent(event: MouseEvent): void {
        const onChild = event.composedPath()[0] !== element
        if (onChild && options?.propagate === false) return

        if (!activatedOnDown) {
            callback(event, element)
            return
        }

        activatedOnDown = false
        event.preventDefault()
    }
}
