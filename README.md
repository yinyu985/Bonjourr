# Bonjourr

Forked from [victrme/Bonjourr](https://github.com/victrme/Bonjourr), a minimalist browser start page inspired by the looks of iOS.

- 🍏 iOS design language
- 🏞 Dynamic 4K backgrounds that change according to the mood of the day
- ⚡️ Fast & lightweight!
- 🕰 Analog clock with multiple clock faces
- 🔗 Quick Links
- 🌘 Dark mode
- 🥖 Emoji as favicon
- 🧑‍💻 Custom CSS styling
- 📝 Custom fonts
- 🔒 Privacy focused & no generative AI
- 🌎 Multilanguage

<br>

## 🔧 Built with

- No frameworks, plain Typescript & CSS
- Deno for tasks, checks, and local development

<br>

## 👨‍💻 Running Bonjourr

### Run locally

- Install Deno runtime: https://docs.deno.com/runtime/
- Clone this repository
- Run one of the development tasks below

```bash
# In root directory
deno task chrome
deno task edge
deno task firefox
deno task safari
deno task online
```

#### Chrome

- Go to `chrome://extensions`
- Enable Developer mode
- Load unpacked and select `/release/chrome` folder

#### Firefox

- Go to `about:debugging#/runtime/this-firefox`
- Select "Load temporary Add-on"
- Select `manifest.json` in `/release/firefox` folder

#### Edge

- Go to `edge://extensions`
- Enable Developer mode
- Load unpacked and select `/release/edge` folder

#### Safari

- Follow install steps on the [upstream Safari repository](https://github.com/victrme/Bonjourr-Safari)

#### Online (web version)

- A live server opens with `deno task online`
- Go to http://0.0.0.0:8000/

### Using Docker

Prerequisites:

- [Docker](https://docs.docker.com/get-started)

#### Docker CLI

```bash
# Build the container image
docker build -t bonjourr/bonjourr . -f docker/app/Dockerfile

docker run --rm -p "8000:80/tcp" -it bonjourr/bonjourr
```

```bash
# Build using docker compose
docker compose up -f docker/compose.app.yaml -d
```

Go to http://0.0.0.0:8000/

#### Docker Desktop

- Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Search for `bonjourr/bonjourr` Hub image
- Run a new container with `8000` as host port
- Go to http://0.0.0.0:8000/

## 🌍 Publish Bonjourr

To upload a build to Firefox addons, chrome web store, edge addons, you need to create an archive. Docker is needed to ensure Bonjourr is always built the same way across different devices.

- Start Docker
- Run docker compose `docker compose up -f docker/compose.archive.yaml --build` or `deno task archive`
- Archives are located in "release/<platform>"

```bash
# Or "deno task archive"
docker compose -f docker/compose.archive.yaml up --build

# archive-1  | Task build deno task build
# archive-1  | chrome built in: 129ms
# archive-1  | Archiving chrome...
# ...
```
