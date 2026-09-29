/* Log to confirm background script is running */
/* console.log("Background script loaded at", new Date().toISOString()); */

// Command listener
browser.commands.onCommand.addListener(async (command) => {
  if (command === "show-omnibar") {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];

      if (!activeTab || !Number.isInteger(activeTab.id) || activeTab.id < 0) {
        return;
      }

      // Skip internal browser pages where content scripts are restricted
      if (
        !activeTab.url ||
        activeTab.url.startsWith("about:") ||
        activeTab.url.startsWith("moz-extension:") ||
        activeTab.url.includes("addons.mozilla.org")
      ) {
        return;
      }

      try {
        // Attempt regular message delivery
        await browser.tabs.sendMessage(activeTab.id, { type: "showOmnibar" });
      } catch (err) {
        // If content.js is not present on an older or unrefreshed tab, inject it on demand
        if (err.message && err.message.includes("Receiving end does not exist")) {
          await browser.scripting.insertCSS({
            target: { tabId: activeTab.id },
            files: ["content.css"]
          });
          await browser.scripting.executeScript({
            target: { tabId: activeTab.id },
            files: ["content.js"]
          });
          
          // Re-send the message now that the script is alive
          await browser.tabs.sendMessage(activeTab.id, { type: "showOmnibar" });
        } else {
          throw err;
        }
      }
    } catch (error) {
      console.error("Error executing showOmnibar:", error);
    }
  }
});

// Message listener
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  /* console.log("Message received in background:", message); */

  (async () => {
    if (message.type === "getTabs") {
      try {
        const tabs = await browser.tabs.query({ currentWindow: true });
        const groupsById = new Map();

        if (browser.tabGroups && typeof browser.tabGroups.query === "function") {
          const tabGroupIds = [...new Set(tabs.map((tab) => tab.groupId).filter((groupId) => Number.isInteger(groupId) && groupId >= 0))];

          if (tabGroupIds.length > 0) {
            try {
              const groups = await browser.tabGroups.query({});
              groups.forEach((group) => {
                groupsById.set(group.id, group);
              });
            } catch (error) {
              console.error("Error querying tab groups:", error);
            }
          }
        }

        sendResponse(
          tabs.map((tab) => {
            const groupId = Number.isInteger(tab.groupId) ? tab.groupId : -1;
            const group = groupsById.get(groupId);

            return {
              id: tab.id,
              title: tab.title || "Untitled",
              url: tab.url || "",
              favIconUrl: tab.favIconUrl || "",
              windowId: tab.windowId,
              audible: tab.audible || false,
              groupId,
              groupTitle: group?.title || "",
              groupColor: group?.color || "",
            };
          }),
        );
      } catch (error) {
        console.error("Error querying tabs:", error);
        sendResponse({ error: error.message });
      }
    } else if (message.type === "switchTab") {
      const tabId = message.tabId;
      if (!Number.isInteger(tabId) || tabId < 0) {
        sendResponse({ error: "Invalid tabId" });
        return;
      }
      try {
        const tab = await browser.tabs.get(tabId);
        if (!tab || !Number.isInteger(tab.windowId)) {
          sendResponse({ error: "Tab or window not found" });
          return;
        }
        await browser.windows.update(tab.windowId, { focused: true });
        await browser.tabs.update(tabId, { active: true });
        sendResponse({ success: true });
      } catch (error) {
        console.error("Error switching tab:", error);
        sendResponse({ error: error.message });
      }
    } else if (message.type === "closeTab") {
      const tabId = message.tabId;
      if (!Number.isInteger(tabId) || tabId < 0) {
        sendResponse({ error: "Invalid tabId" });
        return;
      }
      try {
        await browser.tabs.remove(tabId);
        sendResponse({ success: true });
      } catch (error) {
        console.error("Error closing tab:", error);
        sendResponse({ error: error.message });
      }
    }
  })();

  return true; // Keep channel open for async response
});