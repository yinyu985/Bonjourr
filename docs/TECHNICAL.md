# Technical Documentation

### Build Commands

Use Deno when running tasks.

- Full Build: `deno task build`
- Platform-Specific (Dev Mode):
  - Chrome: `deno task chrome`
  - Edge: `deno task edge`
  - Online (Web version): `deno task online`
- Serve Locally: `deno task serve` (runs on port 8000 by default)

### Build Output and Lazy Settings

The production build emits ES modules with code splitting. Startup loads only `index.html`, the main stylesheet, and the
main script graph. Settings are a deliberately deferred boundary:

- `settings.html` is fetched only on the first settings interaction.
- `settings.css` contains settings-only and responsive styles and is enabled at the same time.
- `settings.ts` and the CSS/URL editor chunks are loaded through dynamic imports.

Keep settings-only imports out of `index.ts`, startup feature modules, and `style.css`; a static import would silently
pull the deferred payload back into every new-tab load.

### Unsplash BYOK boundary

Unsplash image sources call `api.unsplash.com` directly with an Access Key supplied by the user. The key is local-only:
Chrome/Edge use `chrome.storage.local`, while the online build uses the dedicated `bonjourr-local-secrets` IndexedDB.
It must never be added to `Sync`, exported JSON, remote payloads, or recovery archives. API responses are runtime
validated, image URLs remain hotlinked, each newly selected photo calls its official `download_location`, and visible
photographer/Unsplash attribution is required. The original Bonjourr service is not a fallback.

### Linting & Formatting

Bonjourr strictly follows Deno's built-in formatting and linting rules.

- Lint Code: `deno lint`
- Format Code: `deno task format` (runs `deno fmt`)
- Type Checking: `deno task types` (runs `deno check`)

### Testing

- Run all tests everytime
- Run All Tests: `deno task test`

---

## 2. Code Style & Conventions

### Imports

- Mandatory Extensions: ALWAYS include the file extension in imports (e.g., `import { foo } from './utils.ts'`).
- Deno Modules: Use `jsr:` or `npm:` prefixes for external dependencies as defined in `deno.json`.
- Absolute Paths: Use relative paths for internal modules.

### Typing & Naming

- Strict Typing: Always prefer explicit types over `any`. Leverage TypeScript interfaces and types in `src/types/`.
- Constants: Use `UPPER_SNAKE_CASE` (e.g., `CURRENT_VERSION`, `SYNC_DEFAULT`).
- Functions/Variables: Use `camelCase`.
- File Naming: Use `kebab-case` or lowercase for filenames (e.g., `webext-storage.js`, `settings.ts`).

### Error Handling

- Use `try/catch` blocks for operations that might fail (e.g., storage access, API calls).
- Log warnings/errors using `console.warn` or `console.error` with descriptive messages.
- Avoid silent failures in critical paths like `startup()`.

### DOM Manipulation

- Bonjourr is a browser extension; direct DOM manipulation is standard.
- Use `document.getElementById` or `document.querySelector`.
- Use `dataset` for state management on the `<html>` or `<body>` elements (e.g.,
  `document.documentElement.dataset.theme = 'dark'`).

---

## 3. Project Structure

- `/src/scripts/`: Main application logic.
  - `features/`: Modular components (clock, backgrounds, links, fonts, etc.).
  - `shared/`: Utility functions used across features.
  - `utils/`: Low-level helpers (translations, permissions, etc.).
  - `services/`: Background services and storage management.
- `/src/types/`: TypeScript definitions.
- `/tasks/`: Build and automation scripts (written in TypeScript).
- `/tests/`: Test suite using `deno test`.
- `/_locales/`: Internationalization JSON files.

---

## 4. Internationalization (i18n)

- All user-facing strings should be localized.
- Use `traduction(null, sync.lang)` for initial translation and `setTranslationCache` for caching.
- To update translations after adding new keys to `_locales`, run:
  ```bash
  deno task translate
  ```

## 6. Feature Script & Settings Architecture

### Core Entry Point: The Dispatcher

Each feature exports a single function that acts as a state switcher. It handles two distinct phases:

- Initialization
- Updates

```typescript
export function feature(init?: FeatureSync, update?: FeatureUpdate) {
    if (update) {
        updateFeature(update) // Live update from Settings
        return
    }
    if (init) {
        initFeature(init) // Initial load on Startup
    }
}
```

### UI Handlers (Setters)

Features use internal "handle" or "set" functions to manipulate the DOM. This keeps logic DRY as both initialization and
updates use the same UI handles.

- Styling: Prefer CSS variables on `document.documentElement` (`--feature-property`).
- State: Use `dataset` attributes or class toggles on the feature's container.

```typescript
const setWidth = (val: number) => document.documentElement.style.setProperty('--feature-width', `${val}em`)

const handleToggle = (state: boolean) => container?.classList.toggle('hidden', !state)
```

### The `updateFeature` Logic

This internal function processes partial changes from the settings menu.

1. Read: Fetches the current feature state from `storage.sync`.
2. Apply: Updates the object and immediately triggers the relevant UI Handlers.
3. Persist: Saves the updated object using `eventDebounce({ feature })` to optimize storage writes.

### Settings Wiring (`src/scripts/settings.ts`)

The settings module acts as a declarative controller that connects HTML inputs to feature functions.
`src/scripts/settings-loader.ts` owns the first-interaction HTML/CSS/module load and then invokes `settingsInit` once.

Settings are wired using standard DOM events or the `onclickdown` utility. The convention is to pass `undefined` as the
first argument to signify a live update.

```typescript
// Example Wiring in initOptionsEvents()
paramId('i_feature-property').addEventListener('input', function () {
    feature(undefined, { property: this.value })
})
```

### Input Mapping Convention

| UI Input Type        | Event         | Feature Payload                |
| :------------------- | :------------ | :----------------------------- |
| Sliders / Ranges     | `input`       | `{ property: this.value }`     |
| Dropdowns / Selects  | `change`      | `{ property: this.value }`     |
| Checkboxes / Toggles | `onclickdown` | `{ property: target.checked }` |
| Action Buttons       | `onclickdown` | `{ trigger: true }`            |

### Feature Best Practices

- Parallel States: Ensure the `init` logic and `update` logic are idempotent so settings can be changed repeatedly
  without side effects.
- Decoupling: The settings menu should never manipulate the feature's DOM directly; it must always go through the
  `feature()` entry point.
- Persistence: Only use `eventDebounce` for values that change frequently (like sliders) to avoid hitting browser
  storage limits.
- Naming: File names use `kebab-case`, while entry point functions use `camelCase` matching the feature name.

---

## 7. CSS Architecture & Styling

### Main Entry Point

The primary CSS entry point is `src/styles/style.css`. This file acts as a manifest that imports all other CSS modules
in a specific order.

### Import Order

1. `_global.css` - Must be imported first (CSS custom properties and global variables)
2. Interface styles (global layout, backgrounds, settings trigger)
3. Startup components and features (time, links, bookmarks, notes, etc.)
4. `_responsive.css` - startup-interface responsive breakpoints; imported last

Settings use the separate `src/styles/settings.css` entry point. It imports settings modules, the network form and code
editor styles, then `settings/responsive.css` last. Do not re-add those files to `style.css`.

### File Structure Convention

CSS files are organized by functional area:

- `interface/` - Main page styling
- `settings/` - Settings panel styling
- `features/` - Individual feature styling
- `components/` - Reusable UI components
- `_global.css` - CSS custom properties
- `_responsive.css` - Responsive breakpoints

### Selector Specificity Strategy

The project follows a low selector specificity approach:

1. Class-based styling preferred over ID selectors where possible
2. Repeat selectors rather than complex nested rules
3. Group related rules by functional area with clear comments

### Variable System

Global variables are defined in `_global.css` as CSS custom properties:

```css
:root {
    --page-width: 1600px;
    --page-gap: 1em;
    --font-family: -apple-system, system-ui, Ubuntu, Roboto, 'Open Sans';
    --border-radius: 25px;
}
```

### Theme Support

Light and dark themes are handled via data attributes:

```css
[data-theme='light'] {
    --color-text: #222222;
    --color-param: 255, 255, 255;
    --color-settings: #f2f2f7;
}

[data-theme='dark'] {
    --color-text: #ffffff;
    --color-param: 0, 0, 0;
    --color-settings: #000000;
}
```

### Styling Principles

#### 1. Progressive Enhancement

- Use `@supports` for feature detection
- Provide fallbacks for modern CSS features
- The extension targets modern Chrome and Edge. The ordinary web build remains browser accessible.

#### 2. Responsive Design

- Breakpoints defined in `_responsive.css`
- Use `dvh` units with `vh` fallbacks

#### 3. Performance

- Minimal CSS nesting
- No `!important` declarations
- Efficient selector patterns
- CSS custom properties for runtime theming

#### 4. Maintainability

- Clear file organization
- Descriptive comments when creating complex selectors
- Consistent naming conventions
- Logical grouping of related styles

### Naming Conventions

#### ID Selectors

- `kebab-case` for element IDs
- Descriptive names indicating purpose
- Feature-specific prefixes where appropriate

#### CSS Classes

- Semantic names over presentational
- Reusable utility classes in `other.css`
- State classes like `.shown`, `.hidden`, `.active`

#### CSS Custom Properties

- `--prefix-description` format
- Group related properties
- Document default values

### Animation Guidelines

#### Transition Patterns

- Use CSS custom properties for timing functions
- Consistent easing curves (`--out-cubic`)
- Hardware-accelerated properties (`transform`, `opacity`)

#### Performance Considerations

- `will-change` for animated elements
- Minimize paint operations
- Debounce rapid animations

### Browser Support

- Modern Chrome and Edge
- No polyfills or shims for older browser support
