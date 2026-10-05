// ==UserScript==
// @name QWQC Tabby Voice Engine Bridge
// @description Dedicated standalone ChatGPT Voice engine window for Tabby.
// @author qwqc
// ==/UserScript==

(() => {
  "use strict";

    const ACTOR_NAME = "QwqcHeyTabby";
  const VERSION = "0.9.4";
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

  // Every normal Zen chrome window keeps a tiny takeover watchdog. Exactly one
  // window owns the Tabby command controller at a time. If that host window is
  // later closed, another already-open Zen window notices the stale heartbeat
  // and takes over without requiring a browser restart.
  const HEARTBEAT_PREF = "qwqc.hey_tabby.runtime.controller_heartbeat";
  const OWNER_PREF = "qwqc.hey_tabby.runtime.controller_owner";
  const TAKEOVER_AFTER_MS = 3200;
  const makeTimer = (callback, delay, repeating = false) => {
    const t = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    t.initWithCallback(callback, delay, repeating ? Ci.nsITimer.TYPE_REPEATING_SLACK : Ci.nsITimer.TYPE_ONE_SHOT);
    return t;
  };
  const readHeartbeat = () => {
    try { return Number(Services.prefs.getStringPref(HEARTBEAT_PREF, "0")); } catch (_) { return 0; }
  };
  const readOwner = () => {
    try { return Services.prefs.getStringPref(OWNER_PREF, ""); } catch (_) { return ""; }
  };
  const ownerToken = `${Date.now()}-${Math.random().toString(36).slice(2)}-${window.windowUtils?.outerWindowID || "w"}`;
  let localController = null;
  let takeoverTimer = null;

  function createController(controllerToken) {
    const sleep = ms => new Promise(resolve => makeTimer(() => resolve(), ms, false));
    let destroyed = false;
    let actorRegisteredHere = false;
    let timer = null;
    let heartbeatTimer = null;
    let pollBusy = false;
    let lastSeq = -1;
    let debugVisible = false;
    let engineWindow = null;
    const workerWindows = new Map();

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

    function grantMicPermission(browser = null) {
      const principals = [];
      try {
        principals.push(Services.scriptSecurityManager.createContentPrincipal(
          Services.io.newURI("https://chatgpt.com/"), {}
        ));
      } catch (_) {}
      try { if (browser?.contentPrincipal) principals.push(browser.contentPrincipal); } catch (_) {}
      try {
        const p = browser?.browsingContext?.currentWindowGlobal?.documentPrincipal;
        if (p) principals.push(p);
      } catch (_) {}

      const seen = new Set();
      const rows = [];
      for (const principal of principals) {
        try {
          const origin = String(principal.origin || "");
          const attrs = JSON.stringify(principal.originAttributes || {});
          const key = origin + "|" + attrs;
          if (seen.has(key)) continue;
          seen.add(key);
          Services.perms.addFromPrincipal(
            principal,
            "microphone",
            Ci.nsIPermissionManager.ALLOW_ACTION,
            Ci.nsIPermissionManager.EXPIRE_NEVER,
            0
          );
          rows.push({
            origin,
            originAttributes: principal.originAttributes || {},
            permission: Services.perms.testPermissionFromPrincipal(principal, "microphone"),
          });
        } catch (error) {
          rows.push({ error: String(error) });
        }
      }
      return rows;
    }

    async function micPermissionState() {
      const { browser } = await ensureEngineWindow(2200);
      if (!browser) return { ok:false, result:"engine-browser-unavailable" };
      const rows = grantMicPermission(browser);
      return { ok:true, result:"microphone-permission", rows };
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
        const it = Services.wm.getEnumerator("qwqc:tabby-engine");
        while (it.hasMoreElements()) {
          const existing = it.getNext();
          if (!existing || existing.closed) continue;
          const title = String(existing.document?.title || "");
          if (title.startsWith("Tabby Work · ")) continue;
          engineWindow = existing;
          styleEngineWindow(existing);
          return existing;
        }
      } catch (_) {}
      return null;
    }

    function safeChatUrl(raw) {
      try {
        const url = new URL(String(raw || ""));
        if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/c/")) return null;
        return url.href;
      } catch (_) { return null; }
    }

    function safeTaskId(raw) {
      return String(raw || "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80);
    }

    function workerTitle(taskId) { return `Tabby Work · ${safeTaskId(taskId)}`; }

    function styleWorkerWindow(win, taskId) {
      if (!win || win.closed) return;
      try { win.document.title = workerTitle(taskId); } catch (_) {}
    }

    function findWorkerWindow(taskId) {
      taskId = safeTaskId(taskId);
      const cached = workerWindows.get(taskId);
      if (cached && !cached.closed) return cached;
      try {
        const it = Services.wm.getEnumerator("qwqc:tabby-engine");
        while (it.hasMoreElements()) {
          const win = it.getNext();
          if (!win || win.closed) continue;
          if (String(win.document?.title || "") === workerTitle(taskId)) {
            workerWindows.set(taskId, win);
            return win;
          }
        }
      } catch (_) {}
      return null;
    }

    async function createWorkerWindow(taskId, rawUrl) {
      taskId = safeTaskId(taskId);
      const url = safeChatUrl(rawUrl);
      if (!taskId || !url) return null;
      const host = hostWindow();
      if (!host) return null;
      let win = null;
      try {
        win = host.openDialog(
          ENGINE_CHROME_URL,
          "_blank",
          "chrome,dialog=no,resizable,width=900,height=760,left=-10000,top=-10000"
        );
      } catch (error) {
        log("worker openDialog failed", error);
        return null;
      }
      if (!await waitForEngineWindow(win)) return null;
      styleWorkerWindow(win, taskId);
      workerWindows.set(taskId, win);
      const browser = win.document.getElementById("tabby-browser");
      try {
        browser.loadURI(Services.io.newURI(url), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      } catch (error) {
        log("worker loadURI failed", error);
        return null;
      }
      return win;
    }

    async function ensureWorkerWindow(taskId, rawUrl = "", timeoutMs = 3000, reload = false) {
      taskId = safeTaskId(taskId);
      const url = rawUrl ? safeChatUrl(rawUrl) : null;
      if (!taskId) return { win:null, browser:null, actor:null };
      let win = findWorkerWindow(taskId);
      if (!win && url) win = await createWorkerWindow(taskId, url);
      if (!win || win.closed) return { win:null, browser:null, actor:null };
      if (!await waitForEngineWindow(win, Math.min(timeoutMs, 3000))) return { win,browser:null,actor:null };
      styleWorkerWindow(win, taskId);
      const browser = win.document.getElementById("tabby-browser");
      if (!browser) return { win,browser:null,actor:null };
      let current = "";
      try { current = browser.currentURI?.spec || ""; } catch (_) {}
      if (url && (reload || current !== url)) {
        try {
          browser.loadURI(Services.io.newURI(url), {
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          });
        } catch (_) {}
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const global = browser?.browsingContext?.currentWindowGlobal;
          const uri = String(global?.documentURI?.spec || global?.documentURI || "");
          if (uri.startsWith("https://chatgpt.com/")) {
            const actor = global.getActor?.(ACTOR_NAME);
            if (actor) return { win,browser,actor };
          }
        } catch (_) {}
        await sleep(100);
      }
      return { win,browser,actor:null };
    }

    async function queryWorker(taskId, name, data = {}, timeoutMs = 2500) {
      const { win, actor } = await ensureWorkerWindow(taskId, "", timeoutMs, false);
      if (!actor) return { ok:false, result:"worker-actor-unavailable", taskId:safeTaskId(taskId) };
      try {
        const result = await actor.sendQuery(name, data);
        return { ...result, taskId:safeTaskId(taskId), workerWindow:true,
          engineWindowState:(() => { try { return win.windowState; } catch (_) { return -1; } })() };
      } catch (error) {
        return { ok:false, result:String(error), taskId:safeTaskId(taskId), workerWindow:true };
      }
    }

    async function openWorker(taskId, rawUrl, reload = false) {
      const url = safeChatUrl(rawUrl);
      if (!url) return { ok:false, result:"invalid-chat-url" };
      const { actor } = await ensureWorkerWindow(taskId, url, 9000, reload);
      if (!actor) return { ok:false, result:"worker-open-timeout", taskId:safeTaskId(taskId) };
      const result = await actor.sendQuery("voiceStatus", {});
      return { ...result, ok:true, result:"worker-ready", taskId:safeTaskId(taskId), workerWindow:true };
    }

    async function closeWorker(taskId) {
      taskId = safeTaskId(taskId);
      const win = findWorkerWindow(taskId);
      workerWindows.delete(taskId);
      if (win && !win.closed) {
        try { win.close(); } catch (_) {}
      }
      return { ok:true, result:"worker-closed", taskId };
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
        browser.loadURI(Services.io.newURI(TABBY_URL), {
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
          browser.loadURI(Services.io.newURI(TABBY_URL), {
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
            grantMicPermission(browser);
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

    async function queryNormalSelected(name, data = {}, timeoutMs = 6000) {
      for (const win of browserWindows()) {
        if (!win || win.closed) continue;
        const browser = win.gBrowser?.selectedBrowser;
        if (!browser) continue;
        let uri = "";
        try { uri = browser.currentURI?.spec || ""; } catch (_) {}
        if (!String(uri).startsWith("https://chatgpt.com/")) continue;
        try {
          grantMicPermission(browser);
          const global = browser.browsingContext?.currentWindowGlobal;
          const actor = global?.getActor?.(ACTOR_NAME);
          if (!actor) continue;
          const result = await actor.sendQuery(name, data);
          return { ...result, normalBrowser:true, normalHref:uri };
        } catch (error) {
          return { ok:false, result:"normal-browser-query-failed", error:String(error), normalHref:uri };
        }
      }
      return { ok:false, result:"normal-chatgpt-tab-not-found" };
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

    async function focusEngineContent() {
      const { win, browser, actor } = await ensureEngineWindow(3000);
      if (!win || !browser) return { ok:false, result:"engine-browser-unavailable" };
      try { win.focus(); } catch (_) {}
      try { Services.focus.activeWindow = win; } catch (_) {}
      try { Services.focus.setFocus(browser, Services.focus.FLAG_NOSCROLL); } catch (_) {
        try { browser.focus(); } catch (_) {}
      }
      try { browser.focus(); } catch (_) {}
      await sleep(80);
      let actorResult = {};
      if (actor) {
        try { actorResult = await actor.sendQuery("focusMicControl", {}); } catch (_) {}
      }
      let focused = null;
      try { focused = Services.focus.focusedElement; } catch (_) {}
      return {
        ok: Boolean(actorResult?.ok),
        result: actorResult?.ok ? "engine-content-focused" : "engine-content-focus-failed",
        actorResult,
        chromeActiveTitle: String(Services.focus.activeWindow?.document?.title || ""),
        chromeFocusedTag: String(focused?.tagName || focused?.localName || ""),
        chromeFocusedId: String(focused?.id || ""),
        debugVisible,
      };
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
        browser.loadURI(Services.io.newURI(TABBY_URL), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        return { ok: true, result: "navigating" };
      } catch (error) {
        return { ok: false, result: "navigation-failed", error: String(error) };
      }
    }

    async function openChat(rawUrl) {
      const url = safeChatUrl(rawUrl);
      if (!url) return { ok:false, result:"invalid-chat-url" };
      const { win, browser } = await ensureEngineWindow(3000);
      if (!win || !browser) return { ok:false, result:"engine-browser-unavailable" };
      try {
        const status = await query("voiceStatus", {}, 900);
        if (status?.active) await query("endVoice", {}, 1200);
      } catch (_) {}
      try {
        browser.loadURI(Services.io.newURI(url), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      } catch (error) {
        return { ok:false, result:"navigation-failed", error:String(error) };
      }
      let stable = 0;
      let lastHref = "";
      for (let i=0;i<80;i++) {
        await sleep(120);
        const status = await query("voiceStatus", {}, 650);
        if (!status.ok) { stable=0; continue; }
        if (status.loggedOut) return { ...status, result:"needs-login" };
        const usable = status.composerReady && String(status.href || "").startsWith(url.split("?")[0]);
        if (usable && status.href === lastHref) stable += 1;
        else stable = usable ? 1 : 0;
        lastHref = status.href || "";
        if (stable >= 2) return { ...status, ok:true, result:"chat-open-ready" };
      }
      return { ok:false, result:"open-chat-timeout" };
    }

    async function continueChat() {
      let status = await query("voiceStatus", {}, 1000);
      if (status?.active) {
        await query("endVoice", {}, 1200);
        await sleep(180);
        status = await query("voiceStatus", {}, 1000);
      }
      if (status?.loggedOut) return { ...status, result: "needs-login" };

      for (let i = 0; i < 35; i++) {
        if (status?.ok && status?.composerReady) {
          let fresh = false;
          try {
            const url = new URL(status.href || "");
            fresh = url.origin === "https://chatgpt.com" && url.pathname === "/";
          } catch (_) {}
          return { ...status, ok: true, fresh, result: "continue-ready" };
        }
        await sleep(120);
        status = await query("voiceStatus", {}, 650);
        if (status?.loggedOut) return { ...status, result: "needs-login" };
      }
      return { ...status, ok: false, result: "continue-timeout" };
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
      } else if (name === "continue-chat") {
        let win = findEngineWindow();
        if (!win) win = await createEngineWindow();
        setEngineVisible(win, Boolean(command.debug));
        result = await continueChat();
      } else if (name === "open-chat") {
        result = await openChat(String(command.url || ""));
      } else if (name === "worker-open") {
        result = await openWorker(command.taskId, command.url, Boolean(command.reload));
      } else if (name === "worker-status") {
        result = await queryWorker(command.taskId, "voiceStatus", {}, 1800);
      } else if (name === "worker-latest-response") {
        result = await queryWorker(command.taskId, "latestAssistantResponse", {}, 1800);
      } else if (name === "worker-close") {
        result = await closeWorker(command.taskId);
      } else if (name === "activate") {
        const { win } = await ensureEngineWindow();
        setEngineVisible(win, Boolean(command.debug));
        // Return immediately after the trusted Voice click. ChatGPT replaces
        // parts of the Voice surface while it starts; keeping this poller
        // occupied during that rehydration made a successful activation look
        // like a timeout. The Tabby backend polls voiceStatus independently.
        result = await query("activateVoice");
      } else if (name === "arm-mic-probe") {
        result = await query("armMicEventProbe", {}, 1200);
      } else if (name === "mic-probe-state") {
        result = await query("micEventProbeState", {}, 1200);
      } else if (name === "audio-track-state") {
        result = await query("audioTrackState", {}, 1200);
      } else if (name === "force-audio-tracks-on") {
        result = await query("forceAudioTracksOn", {}, 1600);
      } else if (name === "probe-mic-media") {
        result = await query("probeMicrophoneMedia", {}, 8000);
      } else if (name === "mic-permission") {
        result = await micPermissionState();
      } else if (name === "normal-media-environment") {
        result = await queryNormalSelected("mediaEnvironment", {}, 5000);
      } else if (name === "normal-probe-mic-media") {
        result = await queryNormalSelected("probeMicrophoneMedia", {}, 7000);
      } else if (name === "media-environment") {
        const { browser } = await ensureEngineWindow(2200);
        const actorState = await query("mediaEnvironment", {}, 5000);
        result = {
          ...actorState,
          browserDocShellIsActive: (() => { try { return Boolean(browser?.docShellIsActive); } catch (_) { return null; } })(),
          browsingContextIsActive: (() => { try { return Boolean(browser?.browsingContext?.isActive); } catch (_) { return null; } })(),
          remoteType: String(browser?.remoteType || ""),
        };
      } else if (name === "focus-engine-content") {
        result = await focusEngineContent();
      } else if (name === "focus-mic") {
        result = await query("focusMicControl", {}, 1200);
      } else if (name === "mic-on") {
        result = await query("ensureMicrophoneOn", {}, 2200);
      } else if (name === "send-text") {
        result = await query("sendText", { text: String(command.text || "") });
      } else if (name === "latest-response") {
        result = await query("latestAssistantResponse", {}, 1200);
      } else if (name === "read-aloud") {
        result = await query("readLatestAloud", {}, 1600);
      } else if (name === "paste-image") {
        result = await query("pasteImage", {
          base64: String(command.base64 || ""),
          mime: String(command.mime || "image/png"),
          name: String(command.name || "tabby-paste.png"),
        });
      } else if (name === "end") {
        result = await query("endVoice", {}, 1200);
        if (Boolean(command.reset)) await resetEngineToMarker();
        const win = findEngineWindow();
        setEngineVisible(win, Boolean(command.debug));
      } else if (name === "debug-mic") {
        result = await query("debugMicControl", {}, 1500);
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
        if (readOwner() === controllerToken)
          Services.prefs.setStringPref(HEARTBEAT_PREF, String(now));
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

      Services.prefs.setStringPref(OWNER_PREF, controllerToken);
      Services.prefs.setStringPref(HEARTBEAT_PREF, String(Date.now()));
      heartbeatTimer = makeTimer(() => {
        try {
          if (!destroyed && readOwner() === controllerToken)
            Services.prefs.setStringPref(HEARTBEAT_PREF, String(Date.now()));
        } catch (_) {}
      }, 500, true);
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
      if (heartbeatTimer) { try { heartbeatTimer.cancel(); } catch (_) {} }
      if (actorRegisteredHere) {
        try { ChromeUtils.unregisterWindowActor(ACTOR_NAME); } catch (_) {}
      }
      if (readOwner() === controllerToken) {
        Services.prefs.setBoolPref("qwqc.hey_tabby.runtime.loaded", false);
        try { Services.prefs.setStringPref(HEARTBEAT_PREF, "0"); } catch (_) {}
        try { Services.prefs.setStringPref(OWNER_PREF, ""); } catch (_) {}
      }
    }

    init().catch(error => {
      try { Services.prefs.setStringPref("qwqc.hey_tabby.runtime.bootstrap_error", String(error)); } catch (_) {}
      console.error("[Tabby Engine] init failed", error);
    });
    return { version: VERSION, destroy, token: controllerToken };
  }

  const tryTakeover = () => {
    try {
      const now = Date.now();
      const heartbeat = readHeartbeat();
      if (now - heartbeat < TAKEOVER_AFTER_MS) return false;
      // Firefox chrome-window callbacks run on the parent main thread, so this
      // claim/write pair is serialized across windows. Claim before creating
      // the controller so the next watchdog sees a fresh owner immediately.
      Services.prefs.setStringPref(OWNER_PREF, ownerToken);
      Services.prefs.setStringPref(HEARTBEAT_PREF, String(now));
      if (localController) {
        try { localController.destroy(); } catch (_) {}
      }
      localController = createController(ownerToken);
      return true;
    } catch (error) {
      try { Services.prefs.setStringPref("qwqc.hey_tabby.runtime.bootstrap_error", String(error)); } catch (_) {}
      console.error("[Tabby Engine] takeover failed", error);
      return false;
    }
  };

  const start = () => {
    tryTakeover();
    takeoverTimer = makeTimer(() => {
      // If another window owns the controller its independent heartbeat stays
      // fresh. If that owner disappears, this window becomes the replacement.
      if (Date.now() - readHeartbeat() >= TAKEOVER_AFTER_MS) tryTakeover();
    }, 1000, true);
  };

  window.addEventListener("unload", () => {
    if (takeoverTimer) { try { takeoverTimer.cancel(); } catch (_) {} }
    if (localController) { try { localController.destroy(); } catch (_) {} }
  }, { once: true });

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
})();
