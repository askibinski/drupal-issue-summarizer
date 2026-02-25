(() => {
  // Guard against double injection
  if (document.getElementById("dis-panel")) return;

  // Extract node ID from URL: /project/{name}/issues/{nodeId}
  const match = window.location.pathname.match(
    /\/project\/[^/]+\/issues\/(\d+)$/
  );
  if (!match) return;
  const nodeId = match[1];

  // Create panel
  const panel = document.createElement("div");
  panel.id = "dis-panel";
  panel.className = "dis-panel";

  // Restore collapse state
  const isCollapsed = sessionStorage.getItem("dis-collapsed") === "true";
  if (isCollapsed) panel.classList.add("dis-collapsed");

  panel.innerHTML = `
    <div class="dis-header" id="dis-header" role="button" tabindex="0"
         aria-expanded="${isCollapsed ? "false" : "true"}" aria-controls="dis-body">
      <svg class="dis-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect width="20" height="20" rx="4" fill="#0076b6"/>
        <path d="M5 7h10M5 10h10M5 13h7" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span class="dis-title">AI Summary</span>
      <span class="dis-badge" id="dis-badge" aria-live="polite"></span>
      <button class="dis-btn dis-btn-analyze" id="dis-analyze" title="Analyze issue with Claude" aria-label="Analyze issue">
        <span aria-hidden="true">&#x2728;</span> Analyze
      </button>
      <button class="dis-btn" id="dis-reanalyze" title="Re-analyze issue" aria-label="Re-analyze issue" style="display:none;">
        <span aria-hidden="true">&#x21bb;</span> Re-analyze
      </button>
      <span class="dis-collapse-icon" id="dis-collapse-icon" aria-hidden="true">&#x25BC;</span>
    </div>
    <div class="dis-body" id="dis-body">
      <div class="dis-idle" id="dis-idle">
        Click <strong>Analyze</strong> to summarize this issue with Claude AI.
      </div>
      <div class="dis-loading" id="dis-loading" role="status" aria-label="Loading summary" style="display:none;">
        <div class="dis-spinner"></div>
        <span>Analyzing issue with Claude...</span>
      </div>
      <div class="dis-content" id="dis-content" style="display:none;"></div>
      <div class="dis-error" id="dis-error" style="display:none;" role="alert"></div>
      <div class="dis-footer" id="dis-footer" style="display:none;">
        Powered by Claude AI &middot; Drupal Issue Summarizer
      </div>
    </div>
  `;

  // Inject into page
  const anchor =
    document.getElementById("content") ||
    document.querySelector(".layout-container") ||
    document.querySelector("main") ||
    document.body;
  anchor.insertBefore(panel, anchor.firstChild);

  // Cache element references (these are static, injected once)
  const els = {
    header: document.getElementById("dis-header"),
    idle: document.getElementById("dis-idle"),
    loading: document.getElementById("dis-loading"),
    content: document.getElementById("dis-content"),
    error: document.getElementById("dis-error"),
    footer: document.getElementById("dis-footer"),
    badge: document.getElementById("dis-badge"),
    analyze: document.getElementById("dis-analyze"),
    reanalyze: document.getElementById("dis-reanalyze"),
  };

  // Collapse toggle
  function toggleCollapse() {
    panel.classList.toggle("dis-collapsed");
    const collapsed = panel.classList.contains("dis-collapsed");
    sessionStorage.setItem("dis-collapsed", collapsed);
    els.header.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
  els.header.addEventListener("click", (e) => {
    if (e.target.closest(".dis-btn")) return;
    toggleCollapse();
  });
  els.header.addEventListener("keydown", (e) => {
    if (e.target.closest(".dis-btn")) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleCollapse();
    }
  });

  // Analyze button (first-time trigger)
  els.analyze.addEventListener("click", (e) => {
    e.stopPropagation();
    requestSummary(nodeId, false);
  });

  // Re-analyze button (refresh existing summary)
  els.reanalyze.addEventListener("click", (e) => {
    e.stopPropagation();
    requestSummary(nodeId, true);
  });

  // Request counter to discard stale responses from concurrent requests
  let requestId = 0;

  function requestSummary(nodeId, forceRefresh) {
    const thisRequest = ++requestId;
    showLoading();
    chrome.runtime.sendMessage(
      { action: "SUMMARIZE_ISSUE", nodeId, forceRefresh },
      (response) => {
        if (thisRequest !== requestId) return; // discard stale response
        if (chrome.runtime.lastError) {
          showError(chrome.runtime.lastError.message);
          return;
        }
        if (!response) {
          showError("No response from extension. Try reloading the page.");
          return;
        }
        if (response.error) {
          showError(response.error);
          return;
        }
        showSummary(response.summary, response.fromCache);
      }
    );
  }

  function showLoading() {
    els.idle.style.display = "none";
    els.loading.style.display = "flex";
    els.content.style.display = "none";
    els.error.style.display = "none";
    els.footer.style.display = "none";
    els.analyze.disabled = true;
    els.reanalyze.disabled = true;
    els.badge.textContent = "Loading...";
    els.badge.className = "dis-badge dis-badge-loading";
  }

  function showSummary(markdown, fromCache) {
    els.idle.style.display = "none";
    els.loading.style.display = "none";
    els.error.style.display = "none";
    els.content.innerHTML = renderMarkdown(markdown);
    els.content.style.display = "block";
    els.footer.style.display = "block";
    // After first summary, swap Analyze for Re-analyze
    els.analyze.style.display = "none";
    els.reanalyze.style.display = "flex";
    els.reanalyze.disabled = false;
    if (fromCache) {
      els.badge.textContent = "Cached";
      els.badge.className = "dis-badge dis-badge-cached";
    } else {
      els.badge.textContent = "Fresh";
      els.badge.className = "dis-badge dis-badge-fresh";
    }
  }

  function showError(message) {
    els.idle.style.display = "none";
    els.loading.style.display = "none";
    els.content.style.display = "none";
    els.error.textContent = message;
    els.error.style.display = "block";
    els.footer.style.display = "none";
    els.analyze.disabled = false;
    els.reanalyze.disabled = false;
    els.badge.textContent = "Error";
    els.badge.className = "dis-badge dis-badge-error";
  }

  // Minimal markdown-to-HTML renderer.
  // Only handles ## headers, flat - / * bullets, **bold**, and checkboxes.
  // Security: escapeHtml runs BEFORE bold regex to prevent XSS from AI output.
  function renderMarkdown(md) {
    const lines = md.split("\n");
    let html = "";
    let inList = false;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // ## Headers
      if (line.startsWith("## ")) {
        if (inList) { html += "</ul>"; inList = false; }
        html += `<h2>${escapeHtml(line.slice(3))}</h2>`;
        continue;
      }

      // List items: - or - [ ] or - [x]
      const bulletMatch = line.match(/^[-*]\s+(\[[ x]\]\s+)?(.*)/);
      if (bulletMatch) {
        if (!inList) { html += "<ul>"; inList = true; }
        const content = inlineFormat(bulletMatch[2]);
        const checkbox = bulletMatch[1]
          ? bulletMatch[1].includes("x")
            ? "&#9745; "
            : "&#9744; "
          : "";
        html += `<li>${checkbox}${content}</li>`;
        continue;
      }

      // Close list if we're in one and hit a non-list line
      if (inList) { html += "</ul>"; inList = false; }

      // Empty lines
      if (line.trim() === "") {
        continue;
      }

      // Italic line (truncation notice)
      if (line.startsWith("*[") && line.endsWith("]*")) {
        html += `<p><em>${escapeHtml(line.slice(1, -1))}</em></p>`;
        continue;
      }

      // Regular paragraph
      html += `<p>${inlineFormat(line)}</p>`;
    }

    if (inList) html += "</ul>";
    return html;
  }

  function inlineFormat(text) {
    text = escapeHtml(text);
    // **bold** — safe because escapeHtml already neutralized any HTML in text
    text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // `code`
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    return text;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
