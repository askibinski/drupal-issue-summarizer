/**
 * Background service worker for Drupal Issue Summarizer.
 *
 * Data flow: message from content script -> cache check -> Drupal API fetch ->
 * prompt construction -> Claude API call -> cache result -> respond.
 */

// Status, priority, and category mappings for Drupal.org issue metadata.
// Keys are strings to match the Drupal.org API response format.
const STATUS_MAP = {
  "1": "Active",
  "2": "Fixed",
  "3": "Closed (duplicate)",
  "4": "Postponed",
  "5": "Closed (won't fix)",
  "6": "Closed (works as designed)",
  "7": "Closed (fixed)",
  "8": "Needs review",
  "13": "Needs work",
  "14": "Reviewed & tested by the community (RTBC)",
  "15": "Patch (to be ported)",
  "16": "Postponed (maintainer needs more info)",
  "18": "Closed (outdated)",
  "19": "Closed (cannot reproduce)",
};

const PRIORITY_MAP = {
  "400": "Critical",
  "300": "Major",
  "200": "Normal",
  "100": "Minor",
};

const CATEGORY_MAP = {
  "1": "Bug report",
  "2": "Task",
  "3": "Feature request",
  "4": "Support request",
  "5": "Plan",
};

// Deduplication map to prevent concurrent requests for the same issue
const inFlight = new Map();

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "SUMMARIZE_ISSUE") {
    // Chrome terminates service workers after ~30s of inactivity.
    // Keep alive during long Drupal API pagination + Claude API calls.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 25000);
    handleSummarize(message.nodeId, message.forceRefresh)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }))
      .finally(() => clearInterval(keepAlive));
    return true; // keep message channel open for async response
  }
});

async function handleSummarize(nodeId, forceRefresh) {
  // Validate nodeId at trust boundary
  if (!nodeId || !/^\d+$/.test(nodeId)) {
    throw new Error("Invalid issue ID.");
  }

  // Deduplicate concurrent requests for the same issue
  const dedupeKey = `${nodeId}_${forceRefresh}`;
  if (inFlight.has(dedupeKey)) return inFlight.get(dedupeKey);
  const promise = _handleSummarize(nodeId, forceRefresh);
  inFlight.set(dedupeKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(dedupeKey);
  }
}

async function _handleSummarize(nodeId, forceRefresh) {
  const cacheKey = `summary_${nodeId}`;

  // Check cache unless force refresh
  if (!forceRefresh) {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) {
      return { summary: cached[cacheKey], fromCache: true };
    }
  }

  // Get API key (local for security) and model preference (sync across devices)
  const [keyData, modelData] = await Promise.all([
    chrome.storage.local.get("apiKey"),
    chrome.storage.sync.get("model"),
  ]);
  const apiKey = keyData.apiKey;
  const model = modelData.model || "claude-haiku-4-5-20251001";

  if (!apiKey) {
    throw new Error(
      "No API key configured. Click the extension icon to set your Claude API key."
    );
  }

  // Fetch issue data and comments in parallel
  const [issue, comments] = await Promise.all([
    fetchIssue(nodeId),
    fetchComments(nodeId),
  ]);

  // Validate that the fetched node looks like an issue
  if (!issue.title) {
    throw new Error("The fetched node does not appear to be a valid Drupal issue.");
  }

  // Build prompt
  const prompt = buildPrompt(issue, comments);

  // Call Claude API
  const summary = await callClaude(apiKey, model, prompt);

  // Cache result
  await chrome.storage.local.set({ [cacheKey]: summary });

  return { summary, fromCache: false };
}

async function fetchIssue(nodeId) {
  const resp = await fetch(
    `https://www.drupal.org/api-d7/node/${nodeId}.json`
  );
  if (!resp.ok) throw new Error(`Failed to fetch issue (HTTP ${resp.status})`);
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error("Failed to parse issue data. Drupal.org may be temporarily unavailable.");
  }
  return data;
}

async function fetchComments(nodeId) {
  const allComments = [];
  let page = 0;
  const maxPages = 10; // Safety limit: 500 comments max

  while (page < maxPages) {
    const resp = await fetch(
      `https://www.drupal.org/api-d7/comment.json?node=${nodeId}&limit=50&page=${page}&sort=created&direction=ASC`
    );
    if (!resp.ok) {
      if (page === 0) throw new Error(`Failed to fetch comments (HTTP ${resp.status})`);
      break; // tolerate failures on subsequent pages
    }
    let data;
    try {
      data = await resp.json();
    } catch {
      if (page === 0) throw new Error("Failed to parse comments. Drupal.org may be temporarily unavailable.");
      break;
    }
    if (!data.list || data.list.length === 0) break;
    allComments.push(...data.list);
    // If we got fewer than 50, we've reached the end
    if (data.list.length < 50) break;
    page++;
  }

  return allComments;
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "... [truncated]";
}

// Token budget rationale:
// - Claude Haiku 4.5 context: 200k tokens (~800k chars)
// - Target ~20k tokens of input to keep costs low (~$0.001/summary)
// - 80k char cap ~= 20k tokens for English text
// - Individual comments capped at 1000 chars to prevent one verbose
//   comment from dominating the context
function buildPrompt(issue, comments) {
  const status = STATUS_MAP[issue.field_issue_status] || "Unknown";
  const priority = PRIORITY_MAP[issue.field_issue_priority] || "Unknown";
  const category = CATEGORY_MAP[issue.field_issue_category] || "Unknown";

  const body = truncate(stripHtml(issue.body?.value || ""), 10000);

  // Process comments with truncation
  let processedComments = comments.map((c, i) => {
    const text = truncate(stripHtml(c.comment_body?.value || ""), 1000);
    const author = c.name || "Anonymous";
    const date = c.created
      ? new Date(Number(c.created) * 1000).toISOString().split("T")[0]
      : "unknown date";
    return `Comment #${i} by ${author} (${date}):\n${text}`;
  });

  // If total is too long, keep first 5 (original context) + newest 15
  const totalLen = processedComments.reduce((s, c) => s + c.length, 0);
  if (totalLen > 60000) {
    const first = processedComments.slice(0, 5);
    const last = processedComments.slice(-15);
    const omitted = processedComments.length - 20;
    processedComments = [
      ...first,
      `[${omitted} middle comments omitted for brevity]`,
      ...last,
    ];
  }

  const commentsText = processedComments.join("\n\n---\n\n");

  // Enforce 80k char total cap
  const fullText = `# Drupal.org Issue: ${issue.title}

## Metadata
- Status: ${status}
- Priority: ${priority}
- Category: ${category}
- Component: ${issue.field_issue_component || "Unknown"}
- Version: ${issue.field_issue_version || "Unknown"}
- Total comments: ${comments.length}

## Issue Description
${body}

## Comments
${commentsText}`;

  return truncate(fullText, 80000);
}

async function callClaude(apiKey, model, issueContent) {
  const systemPrompt = `You are a technical summarizer for Drupal.org issue threads. Provide a concise, actionable summary using this exact format:

## TL;DR
One or two sentences capturing the essence of the issue.

## Current Status
What is the current state of this issue? What was the most recent action or decision?

## Key Discussion Points
- Point 1
- Point 2
(max 5 points, focus on the most important technical decisions and disagreements)

## Action Items
- [ ] Item 1
- [ ] Item 2
(max 4 items, what needs to happen next based on the discussion)

## Notable Context
Any important background info, related issues, or political/community dynamics worth noting. Omit this section if nothing notable.

Rules:
- Be concise but precise
- Use technical Drupal terminology where appropriate
- Focus on the most recent state, not full history
- If the issue is resolved, note the resolution approach`;

  // The API key is stored in chrome.storage.local which is sandboxed to this
  // extension and not accessible to web pages or other extensions. The
  // anthropic-dangerous-direct-browser-access header is required for direct
  // browser API calls -- acceptable for a personal-use extension.
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Please summarize this Drupal.org issue:\n\n${issueContent}`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const status = resp.status;
    if (status === 401)
      throw new Error(
        "Invalid API key. Check your key in the extension settings."
      );
    if (status === 429)
      throw new Error("Rate limited by Claude API. Please wait and try again.");
    if (status >= 500)
      throw new Error("Claude API is temporarily unavailable. Please try again in a moment.");
    if (status === 400) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(
        `Claude API error: ${body.error?.message || "Bad request"}`
      );
    }
    throw new Error(`Claude API error (HTTP ${status})`);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error("Failed to parse Claude API response.");
  }
  const text = data.content?.[0]?.text;
  if (!text) throw new Error("Empty response from Claude API");

  // Warn user if summary was truncated due to token limit
  if (data.stop_reason === "max_tokens") {
    return text + "\n\n*[Summary was truncated due to length limits]*";
  }
  return text;
}
