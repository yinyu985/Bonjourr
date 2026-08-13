import { ensureDirSync, existsSync } from '@std/fs'
import { buildSync } from 'esbuild'
import { httpServer } from './serve.ts'
import { langList } from '../src/scripts/langs.ts'

type Platform = 'chrome' | 'edge' | 'online'
type Env = 'dev' | 'prod' | 'test'

const PLATFORMS: Platform[] = ['chrome', 'edge', 'online']
const ENVS: Env[] = ['dev', 'prod', 'test']

const args = Deno.args
const platform = args[0]
const env = args[1] ?? 'prod'

const isPlatform = (s: string): s is Platform => PLATFORMS.includes(s as Platform)
const _isEnv = (s: string): s is Env => ENVS.includes(s as Env)

let hashedStylePath = 'src/styles/style.css'
let hashedSettingsStylePath = 'src/styles/settings.css'
let hashedScriptPath = 'src/scripts/main.js'

// Main

removeRetiredPlatformBuilds()

if (env === 'dev' && platform === 'online') {
    httpServer(8000)
}

if (env === 'dev' && isPlatform(platform)) {
    cleanPlatformBuild(platform)
    builder(platform, env)
    watcher(platform)
}

if (env === 'prod' && isPlatform(platform)) {
    cleanPlatformBuild(platform)
    builder(platform, env)
}

if (env === 'prod' && platform === undefined) {
    for (const platform of PLATFORMS) {
        cleanPlatformBuild(platform)
        builder(platform, env)
    }
}

// Build or Watch

function builder(platform: Platform, env: Env): void {
    console.time(`${platform} built in`)

    addDirectories(platform)
    assets(platform)
    locales(platform)
    manifests(platform)
    styles(platform, env)
    scripts(platform, env)
    html(platform, env)

    console.timeEnd(`${platform} built in`)
}

function watcher(platform: Platform): void {
    watchTasks('_locales', (_filename) => {
        locales(platform)
    })

    watchTasks('src', (filename) => {
        if (filename.includes('.html')) {
            html(platform, 'dev')
        }
        if (filename.includes('assets/')) {
            assets(platform)
        }
        if (filename.includes('manifests/')) {
            manifests(platform)
        }
        if (filename.includes('styles/')) {
            styles(platform, 'dev')
        }
        if (filename.includes('scripts/')) {
            scripts(platform, 'dev')
        }
    })
}

function addDirectories(platform: Platform): void {
    try {
        if (existsSync(`release/${platform}/src`)) {
            return
        }
    } catch (_) {
        console.error('First build')
    }

    ensureDirSync(`release/${platform}/src/assets/favicons`)
    ensureDirSync(`release/${platform}/src/assets`)
    ensureDirSync(`release/${platform}/src/scripts`)
    ensureDirSync(`release/${platform}/src/styles`)

    if (platform === 'online') {
        ensureDirSync(`release/${platform}`)
    }
}

// Tasks

function html(platform: Platform, env: Env): void {
    const indexdata = Deno.readTextFileSync('src/index.html')
    const helpModeData = Deno.readTextFileSync('src/help-mode.html')

    const faviconOnline = [
        '<link rel="icon" href="src/assets/favicons/favicon.svg" type="image/svg+xml" id="favicon" />',
        '<link rel="alternate icon" href="src/assets/favicons/favicon-32x32.png" type="image/png" sizes="32x32" />',
        '<link rel="alternate icon" href="src/assets/favicons/favicon.ico" type="image/x-icon" />',
    ].join('\n        ')
    const faviconExtension = '<link rel="icon" id="favicon" />'
    const storage = '<script src="src/scripts/webext-storage.js"></script>'

    let html = indexdata

    if (platform === 'online') {
        html = html.replace('<!-- default icon -->', faviconOnline)
    } else if (platform !== 'edge') {
        html = html.replace('<!-- default icon -->', faviconExtension)
    }
    if (platform !== 'online') {
        html = html.replace('<!-- webext-storage -->', storage)
    }

    // Inject hashed asset paths for online prod builds
    if (platform === 'online' && env === 'prod') {
        html = html.replace('src/styles/style.css', hashedStylePath)
        html = html.replace('src/styles/settings.css', hashedSettingsStylePath)
        html = html.replace('src/scripts/main.js', hashedScriptPath)
    }

    html = html.replace('<!-- help-mode -->', helpModeData)

    Deno.writeTextFileSync(`release/${platform}/index.html`, html)
    Deno.copyFileSync('src/settings.html', `release/${platform}/settings.html`)
}

function styles(platform: Platform, env: Env): void {
    try {
        if (platform === 'online' && env === 'prod') {
            const result = buildSync({
                entryPoints: [
                    { in: 'src/styles/style.css', out: 'style' },
                    { in: 'src/styles/settings.css', out: 'settings' },
                ],
                outdir: `release/${platform}/src/styles`,
                entryNames: '[name]-[hash]',
                format: 'iife',
                bundle: true,
                minify: true,
                metafile: true,
                loader: {
                    '.svg': 'dataurl',
                    '.png': 'file',
                },
            })
            const styleOutput = findEntryOutput(result.metafile.outputs, 'src/styles/style.css')
            const settingsOutput = findEntryOutput(result.metafile.outputs, 'src/styles/settings.css')
            if (styleOutput) hashedStylePath = styleOutput.replace(`release/${platform}/`, '')
            if (settingsOutput) hashedSettingsStylePath = settingsOutput.replace(`release/${platform}/`, '')
        } else {
            buildSync({
                entryPoints: [
                    { in: 'src/styles/style.css', out: 'style' },
                    { in: 'src/styles/settings.css', out: 'settings' },
                ],
                outdir: `release/${platform}/src/styles`,
                entryNames: '[name]',
                format: 'iife',
                bundle: true,
                minify: platform === 'online',
                loader: {
                    '.svg': 'dataurl',
                    '.png': 'file',
                },
            })
        }
    } catch (err) {
        if (env === 'prod') {
            throw (err as Error).message
        } else {
            console.warn((err as Error).message)
        }
    }
}

function scripts(platform: Platform, env: Env): void {
    try {
        if (platform === 'online' && env === 'prod') {
            const result = buildSync({
                entryPoints: [{ in: 'src/scripts/index.ts', out: 'main' }],
                outdir: `release/${platform}/src/scripts`,
                entryNames: '[name]-[hash]',
                chunkNames: 'chunks/[name]-[hash]',
                bundle: true,
                splitting: true,
                format: 'esm',
                target: 'es2023',
                minify: true,
                metafile: true,
                define: {
                    ENV: `"${env.toUpperCase()}"`,
                },
            })
            const outFile = findEntryOutput(result.metafile.outputs, 'src/scripts/index.ts')
            if (outFile) {
                hashedScriptPath = outFile.replace(`release/${platform}/`, '')
            }
        } else {
            buildSync({
                entryPoints: [{ in: 'src/scripts/index.ts', out: 'main' }],
                outdir: `release/${platform}/src/scripts`,
                entryNames: '[name]',
                chunkNames: 'chunks/[name]-[hash]',
                bundle: true,
                splitting: true,
                format: 'esm',
                target: 'es2023',
                minify: platform === 'online',
                sourcemap: env === 'dev',
                define: {
                    ENV: `"${env.toUpperCase()}"`,
                },
            })
        }
    } catch (err) {
        if (env === 'prod') {
            throw (err as Error).message
        } else {
            console.warn((err as Error).message)
        }
    }

    Deno.copyFileSync(
        'src/scripts/services/help-mode.js',
        `release/${platform}/src/scripts/help-mode.js`,
    )

    if (platform !== 'online') {
        Deno.copyFileSync(
            'src/scripts/services/extension-worker.js',
            `release/${platform}/src/scripts/extension-worker.js`,
        )
        Deno.copyFileSync(
            'src/scripts/services/webext-storage.js',
            `release/${platform}/src/scripts/webext-storage.js`,
        )
    }
}

function findEntryOutput(
    outputs: Record<string, { entryPoint?: string }>,
    entryPoint: string,
): string | undefined {
    return Object.entries(outputs).find(([, output]) => output.entryPoint?.replaceAll('\\', '/') === entryPoint)?.[0]
}

function assets(platform: Platform): void {
    const source = `src/assets`
    const target = `release/${platform}/src/assets`

    Deno.copyFileSync(
        `${source}/favicons/favicon-16x16.png`,
        `${target}/favicons/favicon-16x16.png`,
    )
    Deno.copyFileSync(
        `${source}/favicons/favicon-32x32.png`,
        `${target}/favicons/favicon-32x32.png`,
    )
    Deno.copyFileSync(
        `${source}/favicons/favicon-48x48.png`,
        `${target}/favicons/favicon-48x48.png`,
    )
    Deno.copyFileSync(
        `${source}/favicons/favicon-128x128.png`,
        `${target}/favicons/favicon-128x128.png`,
    )
    if (platform === 'online') {
        Deno.copyFileSync(`${source}/favicons/favicon.svg`, `${target}/favicons/favicon.svg`)
        Deno.copyFileSync(`${source}/favicons/favicon.ico`, `${target}/favicons/favicon.ico`)
    }
    copyDir(`${source}/interface`, `${target}/interface`, new Set(['patterns']))
    copyDir(`${source}/labels`, `${target}/labels`)
}

function manifests(platform: Platform): void {
    if (platform === 'online') {
        removeIfExists('release/online/manifest.webmanifest')
        removeIfExists('release/online/service-worker.js')
        Deno.writeTextFileSync('release/online/.nojekyll', '')
    } else {
        Deno.copyFileSync(`src/manifests/${platform}.json`, `release/${platform}/manifest.json`)
    }
}

function removeRetiredPlatformBuilds(): void {
    removeIfExists('release/firefox')
    removeIfExists('release/safari')
}

function cleanPlatformBuild(platform: Platform): void {
    removeIfExists(`release/${platform}`)
}

function removeIfExists(path: string): void {
    if (existsSync(path)) {
        Deno.removeSync(path, { recursive: true })
    }
}

function locales(platform: Platform): void {
    const langs = Object.keys(langList)

    for (const lang of langs) {
        const output = `release/${platform}/_locales/${lang}`

        ensureDirSync(output)

        Deno.copyFileSync(`_locales/${lang}/translations.json`, `${output}/translations.json`)

        if (platform !== 'online') {
            Deno.copyFileSync(`_locales/${lang}/messages.json`, `${output}/messages.json`)
        }
    }
}

// Deno stuff

async function watchTasks(path: string, callback: (filename: string) => void): Promise<void> {
    const watcher = Deno.watchFs(path)
    let debounce = 0

    for await (const event of watcher) {
        if (event.paths.length === 0) {
            continue
        }

        if (debounce) {
            clearTimeout(debounce)
        }

        debounce = setTimeout(() => {
            console.time(`${platform} built in`)
            callback(event.paths[0].replaceAll('\\', '/')) // windows back slashes :(
            console.timeEnd(`${platform} built in`)
        }, 20)
    }
}

function copyDir(source: string, destination: string, excludedNames = new Set<string>()): void {
    ensureDirSync(destination)

    for (const dirEntry of Deno.readDirSync(source)) {
        if (excludedNames.has(dirEntry.name)) continue

        const srcPath = `${source}/${dirEntry.name}`
        const destPath = `${destination}/${dirEntry.name}`

        if (dirEntry.isDirectory) {
            copyDir(srcPath, destPath, excludedNames)
        } else {
            Deno.copyFileSync(srcPath, destPath)
        }
    }
}
