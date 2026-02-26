# Changelog

## 3.2.0

### New Feature: Regent — Coding Agent Orchestrator

Added a hierarchical oversight system for monitoring multiple Claude Code sessions on [Happy Engineering](https://app.happy.engineering). Activates **only** on `app.happy.engineering`; all existing features remain untouched on other sites.

#### Architecture

- **RegentOrchestrator** — Top-level coordinator managing sidecar lifecycle and cross-session state
- **RegentSidecar** — Per-session watcher that buffers messages and triggers AI summarization
- **RegentDetector** — DOM auto-discovery with stored selectors, heuristic analysis, and user calibration
- **RegentSidebar** — Shadow DOM-isolated right sidebar UI with click-to-scroll navigation
- **RegentAIService** — Non-streaming AI summarization via the existing background proxy

#### Highlights

- Auto-detects session containers and chat messages via configurable selectors + heuristic fallback
- Calibration mode: click any chat message to teach the detector (works on any coding agent platform)
- Key events extracted by AI: decisions, errors, file changes, features, bugs, architectural choices
- Click any event in the sidebar to scroll to the source message with a highlight pulse animation
- Collapsible sidebar, dark/light theme support, Apple-inspired glassmorphism design
- SPA navigation support via History API observation (pushState/replaceState/popstate)
- Periodic cross-session meta-summaries every 2 minutes
- Configurable target hostnames via `REGENT_HOSTNAMES` array

#### New Files

- `src/content/regent/RegentOrchestrator.js`
- `src/content/regent/RegentSidecar.js`
- `src/content/regent/RegentDetector.js`
- `src/content/regent/RegentSidebar.js`
- `src/content/regent/RegentAIService.js`
- `src/content/regent/regent.css`

#### Modified Files

- `src/content/content.js` — Site detection + dynamic import of Regent
- `src/background.js` — `requestId`-based AbortController keying, null-safe abort handler

---

## 3.1.6

- Fix custom system prompt character count issue
- Updated release build

## 3.1.5

- Implement copy all conversation history

## 3.1.4

- Enhanced UI: AI answer padding, word wrapping, drag handle visibility
- Expanded content script matching to local files and all frames
- Added KaTeX font support
- Improved background script error handling

## 3.1.3

- Fix persistent scroll logic conflicts with interaction shield

## 3.1.2

- Refined quick actions toolbar: compact input, improved light-mode contrast, draggable handle

## 3.1.1

- Fix auto-scroll for reasoning panel
- Fix AI chat window input restore
- Optimize UI component interactions and theme handling
