// Initialize context menu on extension installation
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "includeImage",
        title: "Ask about image",
        contexts: ["image"]
    });
});

// Process context menu interaction events
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "includeImage") {
        // Forward image information to content script
        chrome.tabs.sendMessage(tab.id, {
            action: "includeImage",
            imageUrl: info.srcUrl
        });

        // Notify side panel to include selected image
        chrome.runtime.sendMessage({
            action: "addImageToChat",
            imageUrl: info.srcUrl
        });
    }
});

// Handle extension icon click to open side panel
chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "closeSidePanel") {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
        chrome.action.setPopup({ popup: '' });
    } else if (request.action === "forwardToSidePanel") {
        chrome.runtime.sendMessage(request);
    }
});


  
