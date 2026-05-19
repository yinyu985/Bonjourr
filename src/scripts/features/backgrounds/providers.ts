const IMAGES: Provider[] = [
    {
        optgroup: 'Bonjourr',
        options: [
            {
                name: 'Bonjourr Daylight',
                value: 'bonjourr-images-daylight',
            },
        ],
    },
    {
        optgroup: 'Unsplash',
        options: [
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
