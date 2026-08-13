chrome.action.onClicked.addListener(createNewTab)
chrome.runtime.onInstalled.addListener(handleInstalled)

function createNewTab() {
    const url = chrome.runtime.getURL('index.html')
    chrome.tabs.create({ url })
}

function handleInstalled(details) {
    if (details.reason === 'install') {
        createNewTab()
    }
}
