interface CompressOptions {
    type?: 'jpeg' | 'png' | 'webp'
    size?: number
    q?: number
    raw?: boolean
    square?: boolean
}

const IMAGE_LOAD_TIMEOUT_MS = 15_000

async function loadOnCanvas(url: string, options: CompressOptions): Promise<HTMLCanvasElement> {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const img = new Image()

    if (!ctx) {
        throw new Error('Cannot get canvas context')
    }

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup()
            reject(new Error('Image loading timed out'))
        }, IMAGE_LOAD_TIMEOUT_MS)

        const cleanup = (): void => {
            clearTimeout(timeout)
            img.onload = null
            img.onerror = null
            img.remove()
        }

        img.onload = () => {
            try {
                const { size, square, raw } = options

                if (raw || !size) {
                    canvas.width = img.width
                    canvas.height = img.height
                    ctx.drawImage(img, 0, 0)

                    cleanup()
                    resolve()
                    return
                }

                const isLandscape = img.width > img.height
                let sx = 0
                let sy = 0
                let sWidth = img.width
                let sHeight = img.height
                let dWidth = size
                let dHeight = size

                if (!square) {
                    if (isLandscape) {
                        dHeight = size
                        dWidth = (img.width / img.height) * size
                    } else {
                        dWidth = size
                        dHeight = (img.height / img.width) * size
                    }
                } else {
                    if (isLandscape) {
                        sx = (img.width - img.height) / 2
                        sWidth = sHeight = img.height
                    } else {
                        sy = (img.height - img.width) / 2
                        sWidth = sHeight = img.width
                    }
                }

                canvas.width = dWidth
                canvas.height = dHeight

                ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, dWidth, dHeight)

                cleanup()
                resolve()
            } catch (err) {
                cleanup()
                reject(err)
            }
        }

        img.onerror = () => {
            cleanup()
            reject(new Error('Cannot load image'))
        }

        img.src = url
    })

    return canvas
}

export async function imageDimensions(src: string): Promise<{ width: number; height: number }> {
    const img = new Image()
    let width = 4000
    let height = 3000

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup()
            reject(new Error('Image dimensions timed out'))
        }, IMAGE_LOAD_TIMEOUT_MS)

        const cleanup = (): void => {
            clearTimeout(timeout)
            img.onload = null
            img.onerror = null
            img.remove()
        }

        img.onload = () => {
            width = img.width
            height = img.height
            cleanup()
            resolve()
        }

        img.onerror = () => {
            cleanup()
            reject(new Error('Cannot read image dimensions'))
        }

        img.src = src
    })

    return { width, height }
}

export async function compressAsBlob(elem: Blob | string, options: CompressOptions): Promise<Blob> {
    const type = options.type ?? 'jpeg'
    const q = options.q ?? 0.9
    const ownsUrl = typeof elem === 'object'
    const url = ownsUrl ? URL.createObjectURL(elem) : elem

    try {
        const canvas = await loadOnCanvas(url, options)
        const ctx = canvas.getContext('2d')

        if (!ctx) {
            throw new Error('Cannot get canvas context')
        }

        return await new Promise<Blob>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Image compression timed out')), IMAGE_LOAD_TIMEOUT_MS)
            try {
                ctx.canvas.toBlob(
                    (blob) => {
                        clearTimeout(timeout)
                        blob ? resolve(blob) : reject(new Error('Image compression failed'))
                    },
                    `image/${type}`,
                    q,
                )
            } catch (err) {
                clearTimeout(timeout)
                reject(err)
            }
        })
    } finally {
        if (ownsUrl) {
            URL.revokeObjectURL(url)
        }
    }
}

export async function compressAsDataUri(elem: Blob | string, options: CompressOptions): Promise<string> {
    const type = options.type ?? 'jpeg'
    const q = options.q ?? 1.0
    const ownsUrl = typeof elem === 'object'
    const url = ownsUrl ? URL.createObjectURL(elem) : elem

    try {
        const canvas = await loadOnCanvas(url, options)
        return canvas.toDataURL(`image/${type}`, q)
    } finally {
        if (ownsUrl) {
            URL.revokeObjectURL(url)
        }
    }
}

export async function svgToText(file: File): Promise<string> {
    const reader = new FileReader()

    const data: string = await new Promise((resolve, reject) => {
        reader.onload = () => {
            resolve(reader.result?.toString() ?? '')
        }

        reader.onerror = () => reject(reader.error ?? new Error('Cannot read SVG'))
        reader.onabort = () => reject(new Error('SVG reading was aborted'))

        reader.readAsText(file)
    })

    return data
}
