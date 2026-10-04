// ==UserScript==
// @name QWQC Hey Tabby Voice Bridge
// @description Hidden dedicated ChatGPT Voice engine for Protocol7/Tabby.
// @author qwqc
// ==/UserScript==

(() => {
  "use strict";

  const INSTANCE_KEY = "__qwqcHeyTabbyBridge";
  const ACTOR_NAME = "QwqcHeyTabby";
  const VERSION = "0.3.0";
  const TABBY_URL = "https://chatgpt.com/?tabby=1";
  const COMMAND_PATH = PathUtils.join(PathUtils.profileDir, "tabby-bridge-command.json");
  const STATE_PATH = PathUtils.join(PathUtils.profileDir, "tabby-bridge-state.json");

  function createController() {
    let destroyed = false;
    let actorRegisteredHere = false;
    let timer = null;
    let lastSeq = -1;
    let pollBusy = false;
    let debugVisible = false;
    let previousTab = null;

    function log(...args) { console.debug("[Hey Tabby]", ...args); }

    function ensureActor() {
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

    function findTabbyTab() {
      if (!window.gBrowser) return null;
      return Array.from(gBrowser.tabs).find(tab => {
        if (tab.getAttribute?.("qwqc-tabby") === "true") return true;
        try { return tab.linkedBrowser?.currentURI?.spec?.includes("tabby=1"); }
        catch (_) { return false; }
      }) || null;
    }

    async function ensureTabbyTab() {
      let tab = findTabbyTab();
      if (!tab) {
        const principal = Services.scriptSecurityManager.getSystemPrincipal();
        tab = gBrowser.addTab(TABBY_URL, { triggeringPrincipal: principal, skipAnimation: true });
        tab.setAttribute("qwqc-tabby", "true");
        tab.collapsed = !debugVisible;
      }
      tab.setAttribute("qwqc-tabby", "true");
      if (debugVisible) {
        try { gBrowser.showTab?.(tab); } catch (_) {}
          tab.collapsed = false;
      } else {
        try { if (typeof gBrowser.hideTab === "function") gBrowser.hideTab(tab); else tab.collapsed = true; }
        catch (_) { tab.collapsed = true; }
      }

      const browser = tab.linkedBrowser;
      if (!browser?.currentURI?.spec?.startsWith("https://chatgpt.com/")) {
        await new Promise(resolve => window.setTimeout(resolve, 400));
      }
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < 30; i++) {
          const global = browser?.browsingContext?.currentWindowGlobal;
          const actor = global?.getActor?.(ACTOR_NAME);
          if (actor) return { tab, actor };
          await new Promise(resolve => window.setTimeout(resolve, 150));
        }
        // Restored tabs may have created their WindowGlobal before the actor
        // registration happened. One reload attaches the newly registered actor.
        try { browser.reload(); } catch (_) {}
        await new Promise(resolve => window.setTimeout(resolve, 500));
      }
      return { tab, actor: null };
    }

    function showTab(tab) {
      debugVisible = true;
      if (gBrowser.selectedTab !== tab) previousTab = gBrowser.selectedTab;
      try { gBrowser.showTab?.(tab); } catch (_) {}
      tab.collapsed = false;
      gBrowser.selectedTab = tab;
      try { window.focus(); } catch (_) {}
    }

    function hideTab(tab) {
      debugVisible = false;
      if (gBrowser.selectedTab === tab) {
        const fallback = previousTab && previousTab.parentNode ? previousTab :
          Array.from(gBrowser.tabs).find(t => t !== tab && !t.hidden && !t.collapsed);
        if (fallback) gBrowser.selectedTab = fallback;
      }
      try {
        if (typeof gBrowser.hideTab === "function") gBrowser.hideTab(tab);
        else tab.collapsed = true;
      } catch (_) { tab.collapsed = true; }
    }

    async function query(name, data = {}) {
      const { tab, actor } = await ensureTabbyTab();
      if (!actor) return { ok: false, result: "actor-unavailable", active: false };
      try {
        const result = await actor.sendQuery(name, data);
        return { ...result, debugVisible, tabHidden: Boolean(tab.collapsed) };
      } catch (error) {
        return { ok: false, result: String(error), active: false, debugVisible };
      }
    }


    async function newChat(tab) {
      try {
        const current = await query("voiceStatus");
        if (current.active) await query("endVoice");
      } catch (_) {}
      const { actor } = await ensureTabbyTab();
      if (!actor) return { ok: false, result: "actor-unavailable" };
      try {
        await actor.sendQuery("newChat", {});
      } catch (error) {
        // Navigation destroys the old content actor before the query can reply.
        // That AbortError is the successful new-chat transition, not a failure.
        if (!/destroyed before query|AbortError/i.test(String(error)))
          return { ok: false, result: "new-chat-navigation-failed", error: String(error) };
      }
      let stable = 0;
      let lastHref = "";
      for (let i = 0; i < 70; i++) {
        await new Promise(resolve => window.setTimeout(resolve, 160));
        const status = await query("voiceStatus");
        if (!status.ok) {
          stable = 0;
          continue;
        }
        if (status.loggedOut)
          return { ...status, result: "needs-login" };
        let fresh = false;
        try { fresh = new URL(status.href).pathname === "/"; } catch (_) {}
        const usable = Boolean(fresh && status.composerReady);
        if (usable && status.href === lastHref)
          stable += 1;
        else
          stable = usable ? 1 : 0;
        lastHref = status.href || "";
        if (stable >= 3) {
          await new Promise(resolve => window.setTimeout(resolve, 220));
          const finalStatus = await query("voiceStatus");
          let finalFresh = false;
          try { finalFresh = new URL(finalStatus.href).pathname === "/"; } catch (_) {}
          if (finalStatus.ok && finalFresh && finalStatus.composerReady)
            return { ...finalStatus, result: "new-chat-ready" };
          stable = 0;
        }
      }
      return { ok: false, result: "new-chat-timeout" };
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
      const { tab } = await ensureTabbyTab();

      if (name === "show") {
        showTab(tab);
        result = await query("voiceStatus");
      } else if (name === "hide") {
        hideTab(tab);
        result = await query("voiceStatus");
      } else if (name === "new-chat") {
        if (command.debug) showTab(tab); else hideTab(tab);
        result = await newChat(tab);
      } else if (name === "activate") {
        if (command.debug) showTab(tab); else hideTab(tab);
        result = await query("activateVoice");
      } else if (name === "send-text") {
        result = await query("sendText", { text: String(command.text || "") });
      } else if (name === "debug-dom") {
        result = await query("debugComposer");
      } else if (name === "paste-image") {
        result = await query("pasteImage", {
          base64: String(command.base64 || ""),
          mime: String(command.mime || "image/png"),
          name: String(command.name || "tabby-paste.png"),
        });
      } else if (name === "end") {
        result = await query("endVoice");
        if (!command.debug) hideTab(tab);
      } else {
        result = await query("voiceStatus");
      }
      await writeState(seq, name, result);
    }

    async function poll() {
      if (destroyed || pollBusy) return;
      pollBusy = true;
      try {
        Services.prefs.setStringPref("qwqc.hey_tabby.runtime.last_poll_ms", String(Date.now()));
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
      ensureActor();
      grantMicPermission();
      Services.prefs.setBoolPref("qwqc.hey_tabby.runtime.loaded", true);
      Services.prefs.setStringPref("qwqc.hey_tabby.runtime.version", VERSION);
      try { await IOUtils.makeDirectory(PathUtils.dirname(COMMAND_PATH), { ignoreExisting: true }); } catch (_) {}
      // Do not replay the command that happened to be on disk before this Zen
      // process started. New commands always carry a larger millisecond seq.
      try {
        if (await IOUtils.exists(COMMAND_PATH)) {
          const stale = await IOUtils.readJSON(COMMAND_PATH);
          lastSeq = Number(stale?.seq ?? -1);
        }
      } catch (_) {}
      timer = window.setInterval(() => poll(), 150);
      await writeState(0, "init", { ok: true, result: "ready", active: false, debugVisible: false });
      log("initialized", VERSION);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (timer) window.clearInterval(timer);
      if (actorRegisteredHere) {
        try { ChromeUtils.unregisterWindowActor(ACTOR_NAME); } catch (_) {}
      }
      Services.prefs.setBoolPref("qwqc.hey_tabby.runtime.loaded", false);
      if (window[INSTANCE_KEY]?.destroy === destroy) delete window[INSTANCE_KEY];
    }

    init().catch(error => console.error("[Hey Tabby] init failed", error));
    return { destroy };
  }

  const start = () => {
    try {
      window[INSTANCE_KEY]?.destroy?.();
      const controller = createController();
      window[INSTANCE_KEY] = controller;
      if (typeof window.addUnloadListener === "function") window.addUnloadListener(() => controller.destroy());
    } catch (error) { console.error("[Hey Tabby] failed to initialize", error); }
  };

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
})();
