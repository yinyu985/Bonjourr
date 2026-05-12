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

## Run Locally

Install the [Deno runtime](https://docs.deno.com/runtime/), clone this repository, then run one of the platform tasks:

```bash
deno task chrome
deno task edge
deno task firefox
deno task safari
deno task online
```

### Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and select `release/chrome`.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on".
3. Select `release/firefox/manifest.json`.

### Edge

1. Open `edge://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and select `release/edge`.

### Safari

Follow the install steps from the [upstream Safari repository](https://github.com/victrme/Bonjourr-Safari).

### Web Version

Run:

```bash
deno task online
```

Then open http://0.0.0.0:8000/.

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

To publish browser builds, create release archives:

```bash
deno task archive
```

The archives are generated under `release/<platform>`.

Docker is used by the archive task so builds stay consistent across machines.

## License

Bonjourr is released under the [GPL-3.0 license](./LICENSE.md).
