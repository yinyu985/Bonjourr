# Bonjourr

[简体中文](./README.zh-CN.md)

Bonjourr is a minimalist, highly customizable new tab extension for modern browsers.

This repository is forked from [victrme/Bonjourr](https://github.com/victrme/Bonjourr). It has evolved into a
privacy-focused new tab page built around a clean interface, browser bookmark links, and local customization.

## Features

- Minimal new tab page with a quiet, customizable interface
- Quick Links shown from the browser's native bookmarks
- Read-only bookmark groups that follow the browser bookmark structure
- Backgrounds from images, videos, remote URLs, local files, or solid colors
- Background filters, texture overlays, local media options, and video mute controls
- Digital clock with seconds, 12-hour time, time zone, and date format options
- Simple memo panel for lightweight notes
- Custom fonts, font weights, sizing, and text shadow controls
- Custom CSS for advanced styling
- Dark mode, tab title, tab icon, and layout controls
- Settings import/export and synchronization through GitHub Gist or a remote URL
- Multilanguage support, including English and Simplified Chinese
- Privacy-focused: no account requirement and no generative AI features

## Built With

- Plain TypeScript, HTML, and CSS
- Deno for tasks, checks, tests, and local development
- No frontend framework

## Install

Download the browser package from the [GitHub Releases page](https://github.com/yinyu985/Bonjourr/releases), then
unzip it.

Release archives are named by platform, for example:

- `bonjourr-chrome.zip`
- `bonjourr-edge.zip`
- `bonjourr-firefox.zip`

### Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select the unzipped `chrome` folder.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on".
3. Select `manifest.json` inside the unzipped `firefox` folder.

### Edge

1. Open `edge://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select the unzipped `edge` folder.

### Safari

Follow the install steps from the [upstream Safari repository](https://github.com/victrme/Bonjourr-Safari).

## Run Locally

Install the [Deno runtime](https://docs.deno.com/runtime/), clone this repository, then run the web version:

```bash
deno task online
```

Then open http://0.0.0.0:8000/.

## Build Extension Packages

These tasks generate browser extension builds under `release/<platform>`:

```bash
deno task chrome
deno task edge
deno task firefox
deno task safari
```

After building, load the generated folder in your browser, for example `release/chrome` in Chrome or
`release/edge` in Edge.

## Docker

Docker is optional for running the web version.

```bash
docker build -t bonjourr/bonjourr . -f docker/app/Dockerfile
docker run --rm -p "8000:80/tcp" -it bonjourr/bonjourr
```

Or use Docker Compose:

```bash
docker compose -f docker/compose.app.yaml up -d
```

Then open http://0.0.0.0:8000/.

## Development

Use Deno for all project tasks:

```bash
deno task build
deno task check
deno task test
deno task types
deno task translate
```

`deno task check` runs formatting, linting, type checking, and tests.

Useful documentation:

- [Technical documentation](./docs/TECHNICAL.md)
- [Manual release checklist](./tests/README.md)
- [Changelog](./CHANGELOG.md)

## Publish

GitHub Releases are created automatically when a tag matching `v*` is pushed.

```bash
git tag v3.0.0
git push origin v3.0.0
```

The release workflow runs `deno task build`, creates `bonjourr-*.zip` archives, and uploads them to the GitHub Release.

To create local archives manually, run:

```bash
deno task archive
```

Docker is used by the local archive task so builds stay consistent across machines.

## License

Bonjourr is released under the [GPL-3.0 license](./LICENSE.md).
