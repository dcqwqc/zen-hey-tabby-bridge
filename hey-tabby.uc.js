// ==UserScript==
// @name QWQC Hey Tabby Voice Bridge
// @description Hidden dedicated ChatGPT Voice engine for Protocol7/Tabby.
// @author qwqc
// ==/UserScript==

(() => {
  "use strict";

  const INSTANCE_KEY = "__qwqcHeyTabbyBridge";
  const ACTOR_NAME = "QwqcHeyTabby";
  const VERSION = "0.2.0";
  const TABBY_URL = "https://chatgpt.com/?tabby=1";
  const COMMAND_PATH = PathUtils.join(PathUtils.profileDir, "tabby-bridge-command.json");
  const STATE_PATH = PathUtils.join(PathUtils.profileDir, "tabby-bridge-state.json");

  function createController() {
    let destroyed = false;
    let actorRegisteredHere = false;
    let timer = null;
    let lastSeq = -1;
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
      tab.collapsed = !debugVisible;

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
      tab.collapsed = true;
    }

    async function query(name) {
      const { tab, actor } = await ensureTabbyTab();
      if (!actor) return { ok: false, result: "actor-unavailable", active: false };
      try {
        const result = await actor.sendQuery(name, {});
        return { ...result, debugVisible, tabHidden: Boolean(tab.collapsed) };
      } catch (error) {
        return { ok: false, result: String(error), active: false, debugVisible };
      }
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
      } else if (name === "activate") {
        if (command.debug) showTab(tab); else hideTab(tab);
        result = await query("activateVoice");
      } else if (name === "end") {
        result = await query("endVoice");
        if (!command.debug) hideTab(tab);
      } else {
        result = await query("voiceStatus");
      }
      await writeState(seq, name, result);
    }

    async function poll() {
      if (destroyed) return;
      try {
        if (await IOUtils.exists(COMMAND_PATH)) {
          const command = await IOUtils.readJSON(COMMAND_PATH);
          await handleCommand(command);
        }
      } catch (error) { log("poll", error); }
    }

    async function init() {
      ensureActor();
      grantMicPermission();
      Services.prefs.setBoolPref("qwqc.hey_tabby.runtime.loaded", true);
      Services.prefs.setStringPref("qwqc.hey_tabby.runtime.version", VERSION);
      try { await IOUtils.makeDirectory(PathUtils.dirname(COMMAND_PATH), { ignoreExisting: true }); } catch (_) {}
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
