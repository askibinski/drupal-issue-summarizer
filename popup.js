const apiKeyInput = document.getElementById("apiKey");
const toggleKeyBtn = document.getElementById("toggleKey");
const modelSelect = document.getElementById("model");
const saveBtn = document.getElementById("save");
const clearCacheBtn = document.getElementById("clearCache");
const statusEl = document.getElementById("status");
let statusTimeout;

// Load saved settings (API key from local, model from sync)
chrome.storage.local.get("apiKey", (localData) => {
  if (chrome.runtime.lastError) return;
  if (localData.apiKey) apiKeyInput.value = localData.apiKey;
});
chrome.storage.sync.get("model", (syncData) => {
  if (chrome.runtime.lastError) return;
  if (syncData.model) modelSelect.value = syncData.model;
});

// Toggle API key visibility
toggleKeyBtn.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleKeyBtn.textContent = isPassword ? "Hide" : "Show";
  toggleKeyBtn.setAttribute(
    "aria-label",
    isPassword ? "Hide API key" : "Show API key"
  );
});

// Save settings
saveBtn.addEventListener("click", () => {
  const apiKey = apiKeyInput.value.trim();
  const model = modelSelect.value;

  if (!apiKey) {
    showStatus("Please enter an API key.", "error");
    return;
  }

  if (!apiKey.startsWith("sk-ant-")) {
    showStatus("API key should start with 'sk-ant-'. Check your key.", "error");
    return;
  }

  // API key in local storage (security), model preference in sync
  chrome.storage.local.set({ apiKey }, () => {
    if (chrome.runtime.lastError) {
      showStatus("Failed to save API key.", "error");
      return;
    }
    chrome.storage.sync.set({ model }, () => {
      if (chrome.runtime.lastError) {
        showStatus("Failed to save model preference.", "error");
        return;
      }
      showStatus("Settings saved.", "success");
    });
  });
});

// Clear cached summaries
clearCacheBtn.addEventListener("click", () => {
  // Uses get(null) because chrome.storage has no "list keys" API
  chrome.storage.local.get(null, (items) => {
    if (chrome.runtime.lastError) {
      showStatus("Failed to read storage.", "error");
      return;
    }
    const keys = Object.keys(items).filter((k) => k.startsWith("summary_"));
    if (keys.length === 0) {
      showStatus("No cached summaries to clear.", "success");
      return;
    }
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        showStatus("Failed to clear cache.", "error");
        return;
      }
      showStatus(`Cleared ${keys.length} cached summary(ies).`, "success");
    });
  });
});

function showStatus(message, type) {
  clearTimeout(statusTimeout);
  statusEl.textContent = message;
  statusEl.className = "status " + type;
  statusTimeout = setTimeout(() => {
    statusEl.className = "status";
  }, 3000);
}
