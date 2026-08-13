const IMAGES: Provider[] = [
    {
        optgroup: 'Unsplash',
        options: [
            {
                name: 'Unsplash Random',
                value: 'unsplash-images-random',
            },
            {
                name: 'Unsplash Collections',
                value: 'unsplash-images-collections',
            },
            {
                name: 'Unsplash Search',
                value: 'unsplash-images-search',
            },
        ],
    },
]

//

interface Provider {
    optgroup: string
    options: {
        name: string
        value: string
    }[]
}

export const PROVIDERS = { IMAGES }
