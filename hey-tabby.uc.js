// ==UserScript==
// @name QWQC Tabby Voice Engine Bridge
// @description Dedicated standalone ChatGPT Voice engine window for Tabby.
// @author qwqc
// ==/UserScript==

(() => {
  "use strict";

    const ACTOR_NAME = "QwqcHeyTabby";
  const VERSION = "0.5.0";
  const TABBY_URL = "https://chatgpt.com/?tabby=1";
  const ENGINE_CHROME_URL = "chrome://userscripts/content/tabby-engine.xhtml";
  const COMMAND_PATH = PathUtils.join(PathUtils.profileDir, "tabby-bridge-command.json");
  const STATE_PATH = PathUtils.join(PathUtils.profileDir, "tabby-bridge-state.json");
  function browserWindows() {
    const out = [];
    try {
      const it = Services.wm.getEnumerator("navigator:browser");
      while (it.hasMoreElements()) out.push(it.getNext());
    } catch (_) {}
    return out;
  }

  // Window scripts can load several times during session restore. A fresh
  // process heartbeat makes this a true single controller without storing the
  // controller on any particular browser window. After a process restart the
  // old heartbeat is stale, so the first restored window takes ownership.
  let controllerHeartbeat = 0;
  try { controllerHeartbeat = Number(Services.prefs.getStringPref("qwqc.hey_tabby.runtime.controller_heartbeat", "0")); } catch (_) {}
  if (Date.now() - controllerHeartbeat < 1500) return;
  try { Services.prefs.setStringPref("qwqc.hey_tabby.runtime.controller_heartbeat", String(Date.now())); } catch (_) {}

  function createController() {
    const makeTimer = (callback, delay, repeating = false) => {
      const t = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      t.initWithCallback(callback, delay, repeating ? Ci.nsITimer.TYPE_REPEATING_SLACK : Ci.nsITimer.TYPE_ONE_SHOT);
      return t;
    };
    const sleep = ms => new Promise(resolve => makeTimer(() => resolve(), ms, false));
    let destroyed = false;
    let actorRegisteredHere = false;
    let timer = null;
    let pollBusy = false;
    let lastSeq = -1;
    let debugVisible = false;
    let engineWindow = null;

    function log(...args) { console.debug("[Tabby Engine]", ...args); }

    function ensureActorRegistration() {
      try {
        ChromeUtils.registerWindowActor(ACTOR_NAME, {
          child: { esModuleURI: "chrome://userscripts/content/actors/QwqcHeyTabbyChild.sys.mjs" },
          matches: ["https://chatgpt.com/*"],
          allFrames: false,
          safeForUntrustedWebProcess: true,
        });
        actorRegisteredHere = true;
      } catch (error) {
        if (error?.name !== "NotSupportedError") throw error;
      }
    }

    function grantMicPermission() {
      try {
        const principal = Services.scriptSecurityManager.createContentPrincipal(
          Services.io.newURI("https://chatgpt.com/"), {}
        );
        Services.perms.addFromPrincipal(principal, "microphone", Services.perms.ALLOW_ACTION);
      } catch (error) { log("mic permission", error); }
    }

    function styleEngineWindow(win) {
      if (!win || win.closed) return;
      try {
        win.document.title = "Tabby Engine";
      } catch (_) {}
    }

    function findEngineWindow() {
      if (engineWindow && !engineWindow.closed) return engineWindow;
      try {
        const existing = Services.wm.getMostRecentWindow("qwqc:tabby-engine");
        if (existing && !existing.closed) {
          engineWindow = existing;
          styleEngineWindow(existing);
          return existing;
        }
      } catch (_) {}
      return null;
    }

    async function waitForEngineWindow(win, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (win && !win.closed && win.document?.readyState === "complete" &&
              win.document.getElementById("tabby-browser"))
            return true;
        } catch (_) {}
        await sleep(100);
      }
      return false;
    }

    function hostWindow() {
      for (const candidate of browserWindows()) {
        if (candidate && !candidate.closed) return candidate;
      }
      return (!window.closed) ? window : null;
    }

    async function createEngineWindow() {
      const host = hostWindow();
      if (!host) return null;
      let win = null;
      try {
        win = host.openDialog(
          ENGINE_CHROME_URL,
          "_blank",
          "chrome,dialog=no,resizable,centerscreen,width=900,height=760"
        );
      } catch (error) {
        log("engine openDialog failed", error);
        return null;
      }
      engineWindow = win;
      if (!await waitForEngineWindow(win)) return null;
      styleEngineWindow(win);

      const browser = win.document.getElementById("tabby-browser");
      try {
        browser.loadURI(TABBY_URL, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      } catch (error) {
        log("engine loadURI failed", error);
        return null;
      }
      return win;
    }

    async function ensureEngineWindow(timeoutMs = 2200) {
      let win = findEngineWindow();
      if (!win) win = await createEngineWindow();
      if (!win || win.closed) return { win: null, browser: null, actor: null };
      if (!await waitForEngineWindow(win, Math.min(timeoutMs, 2500)))
        return { win, browser: null, actor: null };

      styleEngineWindow(win);
      const browser = win.document.getElementById("tabby-browser");
      if (!browser) return { win, browser: null, actor: null };

      let current = "";
      try { current = browser.currentURI?.spec || ""; } catch (_) {}
      if (!current.startsWith("https://chatgpt.com/") && current !== "about:blank") {
        try {
          browser.loadURI(TABBY_URL, {
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          });
        } catch (_) {}
      }

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const global = browser?.browsingContext?.currentWindowGlobal;
          const uri = global?.documentURI?.spec || global?.documentURI || "";
          if (String(uri).startsWith("https://chatgpt.com/")) {
            const actor = global.getActor?.(ACTOR_NAME);
            if (actor) return { win, browser, actor };
          }
        } catch (_) {}
        await sleep(100);
      }
      // Never reload here. ChatGPT routinely replaces its WindowGlobal while
      // entering Voice; a status poll must not disturb that transition.
      return { win, browser, actor: null };
    }

    function setEngineVisible(win, visible) {
      // Visibility is handled exclusively by Hyprland (active workspace vs
      // special:tabby). Never minimize/restore the Gecko window here: on
      // Wayland that caused fullscreen flips and repeated geometry churn.
      debugVisible = Boolean(visible);
      if (!win || win.closed) return;
      styleEngineWindow(win);
    }

    async function query(name, data = {}, timeoutMs = 2200) {
      const { win, actor } = await ensureEngineWindow(timeoutMs);
      if (!actor) return { ok: false, result: "actor-unavailable", active: false, debugVisible };
      try {
        const result = await actor.sendQuery(name, data);
        return {
          ...result,
          debugVisible,
          engineWindow: true,
          engineWindowState: (() => { try { return win.windowState; } catch (_) { return -1; } })(),
        };
      } catch (error) {
        return { ok: false, result: String(error), active: false, debugVisible, engineWindow: true };
      }
    }

    async function navigateEngineToMarker() {
      let win = findEngineWindow();
      if (!win) win = await createEngineWindow();
      if (!win || win.closed) return { ok: false, result: "engine-window-unavailable" };
      if (!await waitForEngineWindow(win, 1800))
        return { ok: false, result: "engine-browser-unavailable" };
      const browser = win.document.getElementById("tabby-browser");
      if (!browser) return { ok: false, result: "engine-browser-unavailable" };
      try {
        browser.loadURI(TABBY_URL, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        return { ok: true, result: "navigating" };
      } catch (error) {
        return { ok: false, result: "navigation-failed", error: String(error) };
      }
    }

    async function freshChat() {
      let current = {};
      try {
        current = await query("voiceStatus", {}, 900);
        if (current.active) {
          await query("endVoice", {}, 1200);
          current = await query("voiceStatus", {}, 900);
        }
      } catch (_) {}

      // end() already parks Tabby on the canonical fresh composer. Reusing
      // that route avoids a full ChatGPT reload on every wake while still
      // guaranteeing that each session starts from a new conversation.
      try {
        const url = new URL(current.href || "");
        const alreadyFresh = url.origin === "https://chatgpt.com" &&
          url.pathname === "/" && url.searchParams.get("tabby") === "1" &&
          current.composerReady && !current.working;
        if (alreadyFresh) {
          try { await query("clearComposer", {}, 900); } catch (_) {}
          return { ...current, ok: true, result: "new-chat-ready" };
        }
      } catch (_) {}

      const navigation = await navigateEngineToMarker();
      if (!navigation.ok) return navigation;

      let stable = 0;
      let lastHref = "";
      for (let i = 0; i < 60; i++) {
        await sleep(120);
        const status = await query("voiceStatus", {}, 550);
        if (!status.ok) { stable = 0; continue; }
        if (status.loggedOut) return { ...status, result: "needs-login" };
        let fresh = false;
        try {
          const url = new URL(status.href);
          fresh = url.pathname === "/" && url.searchParams.get("tabby") === "1";
        } catch (_) {}
        const usable = Boolean(fresh && status.composerReady);
        if (usable && status.href === lastHref) stable += 1;
        else stable = usable ? 1 : 0;
        lastHref = status.href || "";
        if (stable >= 2) {
          try { await query("clearComposer", {}, 900); } catch (_) {}
          return { ...status, ok: true, result: "new-chat-ready" };
        }
      }
      return { ok: false, result: "new-chat-timeout" };
    }

    async function resetEngineToMarker() {
      return navigateEngineToMarker();
    }

    async function writeState(seq, command, result) {
      const payload = {
        seq, command, ...result,
        bridgeLoaded: true,
        version: VERSION,
        timestamp: Date.now(),
      };
      try { await IOUtils.writeJSON(STATE_PATH, payload, { tmpPath: STATE_PATH + ".tmp" }); }
      catch (error) { log("write state", error); }
      return payload;
    }

    async function handleCommand(command) {
      const seq = Number(command?.seq ?? -1);
      if (seq < 0 || seq === lastSeq) return;
      lastSeq = seq;
      const name = String(command?.command || "status");
      let result;
      try {

      if (name === "show") {
        let win = findEngineWindow();
        if (!win) win = await createEngineWindow();
        setEngineVisible(win, true);
        result = { ok: Boolean(win), result: win ? "shown" : "engine-window-unavailable", active: false, debugVisible: true };
      } else if (name === "hide") {
        let win = findEngineWindow();
        if (!win) win = await createEngineWindow();
        setEngineVisible(win, false);
        result = { ok: Boolean(win), result: win ? "hidden" : "engine-window-unavailable", active: false, debugVisible: false };
      } else if (name === "new-chat") {
        let win = findEngineWindow();
        if (!win) win = await createEngineWindow();
        setEngineVisible(win, Boolean(command.debug));
        result = await freshChat();
      } else if (name === "activate") {
        const { win } = await ensureEngineWindow();
        setEngineVisible(win, Boolean(command.debug));
        // Return immediately after the trusted Voice click. ChatGPT replaces
        // parts of the Voice surface while it starts; keeping this poller
        // occupied during that rehydration made a successful activation look
        // like a timeout. The Tabby backend polls voiceStatus independently.
        result = await query("activateVoice");
      } else if (name === "send-text") {
        result = await query("sendText", { text: String(command.text || "") });
      } else if (name === "paste-image") {
        result = await query("pasteImage", {
          base64: String(command.base64 || ""),
          mime: String(command.mime || "image/png"),
          name: String(command.name || "tabby-paste.png"),
        });
      } else if (name === "end") {
        result = await query("endVoice", {}, 1200);
        await resetEngineToMarker();
        const win = findEngineWindow();
        setEngineVisible(win, Boolean(command.debug));
      } else if (name === "debug-dom") {
        result = await query("debugComposer");
      } else if (name === "debug-all") {
        result = await query("debugAllControls");
      } else {
        result = await query("voiceStatus");
      }
      } catch (error) {
        result = { ok: false, result: "bridge-error", error: String(error), debugVisible };
        try { Services.prefs.setStringPref("qwqc.hey_tabby.runtime.last_poll_error", String(error)); } catch (_) {}
      }
      await writeState(seq, name, result || { ok: false, result: "empty-result", debugVisible });
    }

    async function poll() {
      if (destroyed || pollBusy) return;
      pollBusy = true;
      try {
        const now = Date.now();
        Services.prefs.setStringPref("qwqc.hey_tabby.runtime.last_poll_ms", String(now));
        Services.prefs.setStringPref("qwqc.hey_tabby.runtime.controller_heartbeat", String(now));
        if (await IOUtils.exists(COMMAND_PATH)) {
          const command = await IOUtils.readJSON(COMMAND_PATH);
          await handleCommand(command);
        }
      } catch (error) {
        try { Services.prefs.setStringPref("qwqc.hey_tabby.runtime.last_poll_error", String(error)); } catch (_) {}
        log("poll", error);
      } finally {
        pollBusy = false;
      }
    }

    async function init() {
      ensureActorRegistration();
      grantMicPermission();
      Services.prefs.setBoolPref("qwqc.hey_tabby.runtime.loaded", true);
      Services.prefs.setStringPref("qwqc.hey_tabby.runtime.version", VERSION);
      try { Services.prefs.setStringPref("qwqc.hey_tabby.runtime.last_poll_error", ""); } catch (_) {}
      try { Services.prefs.setStringPref("qwqc.hey_tabby.runtime.bootstrap_error", ""); } catch (_) {}
      try { await IOUtils.makeDirectory(PathUtils.dirname(COMMAND_PATH), { ignoreExisting: true }); } catch (_) {}
      try {
        if (await IOUtils.exists(COMMAND_PATH)) {
          const stale = await IOUtils.readJSON(COMMAND_PATH);
          lastSeq = Number(stale?.seq ?? -1);
        }
      } catch (_) {}

      // v0.5 uses a dedicated chrome window with one <browser>. Clean up any
      // leftover tab from the older normal-Zen-window architecture.
      try {
        for (const host of browserWindows()) {
          if (!host || host.closed) continue;
          for (const tab of Array.from(host.gBrowser?.tabs || [])) {
            const uri = tab?.linkedBrowser?.currentURI?.spec || "";
            if (tab.getAttribute("qwqc-tabby") === "true" || uri.includes("tabby=1"))
              host.gBrowser.removeTab(tab, { animate: false });
          }
        }
      } catch (_) {}

      timer = makeTimer(() => { poll(); }, 150, true);
      await writeState(0, "init", {
        ok: true, result: "ready", active: false, debugVisible: false,
        standaloneEngineWindow: true,
      });
      log("initialized", VERSION);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (timer) { try { timer.cancel(); } catch (_) {} }
      if (actorRegisteredHere) {
        try { ChromeUtils.unregisterWindowActor(ACTOR_NAME); } catch (_) {}
      }
      Services.prefs.setBoolPref("qwqc.hey_tabby.runtime.loaded", false);
      try { Services.prefs.setStringPref("qwqc.hey_tabby.runtime.controller_heartbeat", "0"); } catch (_) {}
    }

    init().catch(error => console.error("[Tabby Engine] init failed", error));
    return { version: VERSION, destroy };
  }

  const start = () => {
    try {
      createController();
    } catch (error) {
      try { Services.prefs.setStringPref("qwqc.hey_tabby.runtime.bootstrap_error", String(error)); } catch (_) {}
      console.error("[Tabby Engine] failed to initialize", error);
    }
  };

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
})();
