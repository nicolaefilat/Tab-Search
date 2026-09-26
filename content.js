/*
 * Tab Search - Content Script
 * Fuzzy search with highlighting, debounce, and keyboard shortcuts.
 */

// DP implementation of Levenshtein Minimum Edit Distance
function minEditDistance(s1, s2) {
  if (!s1.length) return s2.length;
  if (!s2.length) return s1.length;

  const dp = Array.from({ length: s1.length + 1 }, () => Array(s2.length + 1).fill(0));

  for (let i = 0; i <= s1.length; i++) dp[i][0] = i;
  for (let j = 0; j <= s2.length; j++) dp[0][j] = j;

  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,       // deletion
        dp[i][j - 1] + 1,       // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[s1.length][s2.length];
}

function getBestWordScore(queryWord, targetString) {
  const words = targetString.toLowerCase().split(/[\s/\-_.]+/);
  let minDistance = Infinity;

  for (const word of words) {
    // 1. Check prefix BEFORE length optimization!
    // This ensures short queries like "wh" still match long words like "whatsapp".
    if (word.startsWith(queryWord)) return 100;

    // 2. Now apply optimization: skip heavy DP calculation for vastly different lengths
    if (Math.abs(word.length - queryWord.length) > 5) continue;

    const distance = minEditDistance(queryWord, word);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }

  let maxAllowedTypos = 0;
  if (queryWord.length >= 6) maxAllowedTypos = 3;
  else if (queryWord.length >= 4) maxAllowedTypos = 1;

  if (minDistance > maxAllowedTypos) return 0;

  if (minDistance === 0) return 100;
  if (minDistance === 1) return 80;
  if (minDistance === 2) return 50;

  return 0;
}

function calculateScore(tab, query) {
  const title = (tab.title || "").toLowerCase();
  const url = (tab.url || "").toLowerCase();

  // Safely extract the hostname (domain)
  let hostname = "";
  try {
    hostname = new URL(tab.url).hostname.toLowerCase();
  } catch (e) {
    // Failsafe for internal browser pages like about:debugging
    hostname = "";
  }

  const queryLower = query.toLowerCase().trim();
  let totalScore = 0;
  let isExactPhraseMatch = false;

  // 1. Exact phrase bonus (Hostname gets absolute priority)
  if (hostname.includes(queryLower)) {
    totalScore += 1000; // Massive bonus for domain matches
    isExactPhraseMatch = true;
  } else if (url.includes(queryLower)) {
    totalScore += 500; // Normal URL match
    isExactPhraseMatch = true;
  }

  if (title.includes(queryLower)) {
    totalScore += 300;
    isExactPhraseMatch = true;
  }

  // 2. Word-by-word matching
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 0);
  const stopWords = new Set(["in", "a", "an", "the", "of", "to", "and", "for", "on", "with", "is", "how"]);

  const meaningfulQueryWords = queryWords.filter(w => !stopWords.has(w));
  let meaningfulMatchedCount = 0;

  for (const qw of queryWords) {
    const scoreTitle = getBestWordScore(qw, title);
    const scoreUrl = getBestWordScore(qw, url) * 1.5;

    // Multiply hostname score by 2.5 so it beats both URL paths and titles
    const scoreHostname = getBestWordScore(qw, hostname) * 2.5;

    const bestWordScore = Math.max(scoreHostname, scoreUrl, scoreTitle);

    if (bestWordScore > 0) {
      if (stopWords.has(qw)) {
        totalScore += Math.floor(bestWordScore * 0.1);
      } else {
        totalScore += bestWordScore;
        meaningfulMatchedCount++;
      }
    }
  }

  // 3. Modifiers and Penalties
  if (meaningfulQueryWords.length > 0) {
    if (meaningfulMatchedCount === 0 && !isExactPhraseMatch) {
      return 0;
    }

    if (meaningfulQueryWords.length > 1) {
      if (meaningfulMatchedCount === meaningfulQueryWords.length) {
        totalScore *= 2;
      } else if (!isExactPhraseMatch) {
        // NEW HARSH PENALTY: Halve the score for EVERY missing word
        const missingWords = meaningfulQueryWords.length - meaningfulMatchedCount;
        totalScore = Math.floor(totalScore / Math.pow(2, missingWords));
      }
    }
  } else if (queryWords.length > 0 && meaningfulQueryWords.length === 0) {
    totalScore = Math.floor(totalScore / 2);
  }

  return totalScore;
}


const MAX_TABS_TO_RENDER = 10;


/* Highlight matched characters in text */
/* Safely append text with highlighted matches using DOM nodes */
function appendHighlightedText(parentElement, text, query) {
  if (!query) {
    parentElement.textContent = text;
    return;
  }

  // Escape regex characters
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Split the string using a capture group so the matched parts are included in the array
  const regex = new RegExp(`(${escapedQuery})`, "gi");
  const parts = text.split(regex);

  for (const part of parts) {
    if (!part) continue;

    if (part.toLowerCase() === query.toLowerCase()) {
      const mark = document.createElement("mark");
      mark.textContent = part; // Safely set text inside <mark>
      parentElement.appendChild(mark);
    } else {
      parentElement.appendChild(document.createTextNode(part)); // Safely append normal text
    }
  }
}

function showOmnibar() {
  if (document.getElementById("zen-tab-omnibar-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "zen-tab-omnibar-overlay";
  overlay.className = "zen-overlay";

  const omnibar = document.createElement("div");
  omnibar.className = "zen-omnibar";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Search open tabs ...";
  input.className = "zen-input";
  input.autofocus = true;

  const countEl = document.createElement("div");
  countEl.className = "zen-count";

  const list = document.createElement("ul");
  list.className = "zen-list";

  omnibar.appendChild(input);
  omnibar.appendChild(countEl);
  omnibar.appendChild(list);
  overlay.appendChild(omnibar);
  document.body.appendChild(overlay);

  input.focus();

  let allTabs = [];
  // selectedIndex = 0 -> first tab in focus will always be selected
  let selectedIndex = 0;
  // update selection based on the first index

  let escListener, visibilityListener;

  /* Fetch tabs with current window filter */
  browser.runtime
    .sendMessage({ type: "getTabs" })
    .then((tabs) => {
      allTabs = tabs.filter((tab) => Number.isInteger(tab.id) && tab.id >= 0);
      renderTabs(allTabs);
    })
    .catch((error) => {
      console.error("Error fetching tabs:", error);
    });

  function renderTabs(filteredTabs, query = "") {
    list.replaceChildren();
    countEl.textContent = `${filteredTabs.length} of ${allTabs.length} tabs`;

    if (filteredTabs.length === 0) {
      const empty = document.createElement("li");
      empty.className = "zen-empty";
      empty.textContent = "No tabs found";
      list.appendChild(empty);
      return;
    }

    filteredTabs.slice(0, MAX_TABS_TO_RENDER).forEach((tab, index) => {
      const li = document.createElement("li");
      li.className = "zen-tab-item";
      li.dataset.tabId = tab.id;
      if (tab.url) li.dataset.url = tab.url;

      const favIcon = document.createElement("div");
      favIcon.className = "zen-favicon";
      const img = document.createElement("img");
      img.src = tab.favIconUrl && tab.favIconUrl.trim() ? tab.favIconUrl : browser.runtime.getURL("icons/default-favicon.svg");
      favIcon.appendChild(img);
      li.appendChild(favIcon);

      const title = document.createElement("span");
      title.className = "zen-title";
      appendHighlightedText(title, tab.title || "Untitled", query);
      li.appendChild(title);

      const url = document.createElement("span");
      try {
        url.textContent = tab.url ? new URL(tab.url).hostname : "No URL";
      } catch {
        url.textContent = "No URL";
      }
      url.className = "zen-url";
      li.appendChild(url);

      if (tab.groupTitle) {
        const group = document.createElement("span");
        group.textContent = tab.groupTitle;
        group.className = "zen-group-badge";
        if (tab.groupColor) {
          group.dataset.groupColor = tab.groupColor;
        }
        li.appendChild(group);
      }

      const closeBtn = document.createElement("span");
      closeBtn.className = "zen-close-btn";
      closeBtn.textContent = "×";
      closeBtn.title = "Close tab";
      li.appendChild(closeBtn);

      li.addEventListener("click", () => {
        if (tab.id === "search-ddg") {
          window.open(tab.url, "_blank"); // Open DDG natively
          closeOmnibar();
        } else {
          switchToTab(tab.id);
        }
      });

      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        browser.runtime.sendMessage({ type: "closeTab", tabId: tab.id });
        // Remove from local array and re-render
        allTabs = allTabs.filter((t) => t.id !== tab.id);
        applyFilter(input.value);
      });

      list.appendChild(li);
    });
    // update selection after rendering all tabs
    updateSelection();
  }

  function applyFilter(query) {
    if (!query.trim()) {
      renderTabs(allTabs);
      return;
    }

    // 1. Filter out bad matches
    const filtered = allTabs
      .map((tab) => ({ tab, score: calculateScore(tab, query) }))
      .filter(tab => tab.score >= (query.trim().split(/\s+/).length * 25))
      .sort((a, b) => b.score - a.score)
      .map(({ tab }) => tab);

    // 2. DuckDuckGo Fallback Trigger
    if (filtered.length === 0) {
      filtered.push({
        id: "search-ddg", // Special ID to catch in your click handler
        title: `Search DuckDuckGo for "${query}"`,
        url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        favIconUrl: "https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Ftse1.mm.bing.net%2Fth%2Fid%2FOIP.ChtUuaJk4hbc_eiBtWl4CgHaHa%3Fpid%3DApi&f=1&ipt=6cf1b88646280ccd26f3d111a915f40c8e275c29220113a2b6330b7581688923&ipo=images",
        openNew: true,
      });
    }
    renderTabs(filtered, query);
  }

  function updateSelection() {
    const items = list.querySelectorAll("li");
    items.forEach((item) => item.classList.remove("selected"));
    if (selectedIndex >= 0 && selectedIndex < items.length) {
      items[selectedIndex].classList.add("selected");
      items[selectedIndex].scrollIntoView({ block: "nearest" });
    }
  }

  function switchToTab(tabId, openNew = false) {
    if (openNew) {
      browser.tabs.create({ active: true, index: null, url: null }).then(() => {
        // Switch to the newly created tab
        browser.tabs.update(tabId, { active: true });
      });
    } else {
      browser.runtime
        .sendMessage({ type: "switchTab", tabId })
        .then((response) => {
          if (!response?.error) closeOmnibar();
        })
        .catch((error) => {
          console.error("Error switching tab:", error);
        });
    }
  }

  function closeOmnibar() {
    const overlay = document.getElementById("zen-tab-omnibar-overlay");
    if (overlay) {
      overlay.remove();
      document.removeEventListener("keydown", escListener);
      document.removeEventListener("visibilitychange", visibilityListener);
    }
  }

  escListener = (e) => {
    if (e.key === "Escape") {
      closeOmnibar();
      e.preventDefault();
      e.stopPropagation();
    }
  };
  document.addEventListener("keydown", escListener);

  visibilityListener = () => {
    if (document.hidden) closeOmnibar();
  };
  document.addEventListener("visibilitychange", visibilityListener);

  // Debounced input handler
  let debounceTimer;
  input.addEventListener("input", (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      selectedIndex = 0;
      updateSelection();
      applyFilter(e.target.value);
    }, 50);
  });


  // Keyboard navigation
  input.addEventListener("keydown", (e) => {
    const items = list.querySelectorAll("li");
    const numItems = items.length;

    if (e.key === "ArrowDown" || e.key === "Tab") {
      selectedIndex = selectedIndex < numItems - 1 ? selectedIndex + 1 : 0;
      updateSelection();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      selectedIndex = selectedIndex <= 0 ? numItems - 1 : selectedIndex - 1;
      updateSelection();
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      selectedIndex = Math.min(selectedIndex + 10, numItems - 1);
      updateSelection();
      e.preventDefault();
    } else if (e.key === "ArrowLeft") {
      selectedIndex = Math.max(selectedIndex - 10, 0);
      updateSelection();
      e.preventDefault();
    } else if (e.key === "Enter") {
      if (selectedIndex >= 0 && numItems > 0) {
        const selectedItem = items[selectedIndex];
        const rawId = selectedItem.dataset.tabId;

        if (rawId === "search-ddg") {
          // Handle DuckDuckGo fallback
          window.open(selectedItem.dataset.url, "_blank");
          closeOmnibar();
        } else {
          // Handle standard tab switching
          const tabId = parseInt(rawId, 10);
          switchToTab(tabId, e.metaKey || e.ctrlKey);
        }
      }
      e.preventDefault();
    }
  });

  // Close on click outside
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeOmnibar();
  });
}

/* Listen for messages from background */
browser.runtime.onMessage.addListener((message) => {
  if (message.type === "showOmnibar") {
    showOmnibar();
  }
});