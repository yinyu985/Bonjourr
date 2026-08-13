#!/bin/sh

version="3.0.0"

deno task build

# Archives builds with the correct name

for name in chrome edge online; do
    folder="/release/$name"
    [ -d "$folder" ] || continue
    archive_name="bonjourr-${name}-${version}.zip"

    echo "Archiving $name..."

    (cd "$folder" && zip -r "/release/$name/$archive_name" *)
done
