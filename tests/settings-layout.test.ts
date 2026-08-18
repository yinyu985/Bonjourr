import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { walkSync } from '@std/fs'

Deno.test('Advanced settings are always visible without a show-all switch', () => {
    const html = Deno.readTextFileSync('src/settings.html')
    const globalStyles = Deno.readTextFileSync('src/styles/settings/global.css')
    const dropdownStyles = Deno.readTextFileSync('src/styles/settings/dropdowns.css')

    assert(!html.includes('i_showall'))
    assert(!html.includes('Show all settings'))
    assertStringIncludes(globalStyles, '.dropdown.shown')
    assert(!globalStyles.includes('.as_provider'))
    assert(!dropdownStyles.includes('.as_provider'))
})

Deno.test('Settings markup, styles, and editor code stay out of the startup payload', () => {
    const index = Deno.readTextFileSync('src/index.html')
    const mainStyles = Deno.readTextFileSync('src/styles/style.css')
    const settingsStyles = Deno.readTextFileSync('src/styles/settings.css')
    const notes = Deno.readTextFileSync('src/scripts/features/notes.ts')
    const build = Deno.readTextFileSync('tasks/build.ts')

    assertStringIncludes(index, 'data-content-src="settings.html"')
    assertStringIncludes(index, 'data-href="src/styles/settings.css"')
    assert(!index.includes('<!-- settings -->'))
    assert(!mainStyles.includes('./settings/'))
    assertStringIncludes(settingsStyles, './settings/global.css')
    assertStringIncludes(settingsStyles, './settings/responsive.css')
    assert(!mainStyles.includes('./settings/responsive.css'))
    assert(!notes.includes('../settings.ts'))
    assertStringIncludes(build, 'splitting: true')
    assertStringIncludes(build, "format: 'esm'")
})

Deno.test('External network permissions are fixed-host by default and arbitrary HTTPS is optional', () => {
    const helpMode = Deno.readTextFileSync('src/scripts/services/help-mode.js')
    const retiredServiceOrigin = ['https://services', 'bonjourr', 'fr'].join('.')

    for (const platform of ['chrome', 'edge']) {
        const manifest = JSON.parse(Deno.readTextFileSync(`src/manifests/${platform}.json`)) as {
            host_permissions: string[]
            optional_host_permissions: string[]
        }

        assert(!manifest.host_permissions.includes('https://*/*'))
        assert(!manifest.host_permissions.includes(`${retiredServiceOrigin}/*`))
        assert(manifest.host_permissions.includes('https://api.unsplash.com/*'))
        assert(manifest.host_permissions.includes('https://api.github.com/*'))
        assertEquals(manifest.optional_host_permissions, ['https://*/*'])
    }
    for (const root of ['src', 'tasks']) {
        for (
            const entry of walkSync(root, {
                includeDirs: false,
                exts: ['.css', '.html', '.js', '.json', '.md', '.svg', '.ts'],
            })
        ) {
            assert(
                !Deno.readTextFileSync(entry.path).includes(retiredServiceOrigin),
                `Retired service in ${entry.path}`,
            )
        }
    }
    assert(!helpMode.includes('localStorage.setItem(archiveName'))
    assertStringIncludes(helpMode, 'indexedDB.open(ARCHIVE_DATABASE, 1)')
})

Deno.test('Retired assets and replaceable direct dependencies stay out of builds', () => {
    const deno = JSON.parse(Deno.readTextFileSync('deno.json')) as { imports: Record<string, string> }
    const build = Deno.readTextFileSync('tasks/build.ts')
    const sourceAssets = [...Deno.readDirSync('src/assets')].map((entry) => entry.name)
    const interfaceAssets = [...Deno.readDirSync('src/assets/interface')].map((entry) => entry.name)

    assert(!('@victr/deepmerge' in deno.imports))
    assert(!('clickdown' in deno.imports))
    assert(!('pocket-editor' in deno.imports))
    assert(!('happy-dom' in deno.imports))
    assert(!sourceAssets.includes('sounds'))
    assert(!sourceAssets.includes('screenshots'))
    assert(!interfaceAssets.includes('weather'))
    assert(!build.includes('copyDir(`${source}/sounds`'))
    assertStringIncludes(build, "new Set(['patterns'])")
})
