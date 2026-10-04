// ==UserScript==
// @name QWQC Hey Tabby Voice Bridge
// @description Focus the dedicated ChatGPT companion tab and activate real ChatGPT Voice.
// @author qwqc
// ==/UserScript==

(() => {
  "use strict";

  const INSTANCE_KEY = "__qwqcHeyTabbyBridge";
  const ACTOR_NAME = "QwqcHeyTabby";
  const VERSION = "0.1.0";

  function createController() {
    let destroyed = false;
    let actorRegisteredHere = false;
    const cleanup = [];

    function log(...args) {
      console.debug("[Hey Tabby]", ...args);
    }

    function ensureActor() {
      try {
        ChromeUtils.registerWindowActor(ACTOR_NAME, {
          child: {
            esModuleURI: "chrome://userscripts/content/actors/QwqcHeyTabbyChild.sys.mjs",
          },
          matches: ["https://chatgpt.com/*"],
          allFrames: false,
          safeForUntrustedWebProcess: true,
        });
        actorRegisteredHere = true;
      } catch (error) {
        if (error?.name !== "NotSupportedError") {
          throw error;
        }
      }
    }

    function chatGptTabs() {
      if (!window.gBrowser) return [];
      return Array.from(gBrowser.tabs).filter((tab) => {
        try {
          return tab?.linkedBrowser?.currentURI?.spec?.startsWith("https://chatgpt.com/");
        } catch (_) {
          return false;
        }
      });
    }

    function chooseCompanionTab() {
      const tabs = chatGptTabs();
      if (!tabs.length) return null;

      const pinned = tabs.filter((tab) => tab.pinned || tab.hasAttribute?.("pinned"));
      const pool = pinned.length ? pinned : tabs;

      const selected = pool.find((tab) => tab === gBrowser.selectedTab);
      if (selected) return selected;

      return pool
        .slice()
        .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0] || pool[0];
    }

    async function openCompanionTab() {
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      const tab = gBrowser.addTab("https://chatgpt.com/", {
        triggeringPrincipal: principal,
      });
      gBrowser.selectedTab = tab;

      await new Promise((resolve) => {
        const browser = tab.linkedBrowser;
        if (!browser || browser.currentURI?.spec?.startsWith("https://chatgpt.com/")) {
          window.setTimeout(resolve, 350);
          return;
        }
        const done = () => {
          browser.removeEventListener("load", done, true);
          window.setTimeout(resolve, 250);
        };
        browser.addEventListener("load", done, true);
        window.setTimeout(done, 5000);
      });
      return tab;
    }

    async function activateVoice() {
      if (destroyed || !window.gBrowser) return { ok: false, result: "bridge-unavailable" };

      let tab = chooseCompanionTab();
      if (!tab) tab = await openCompanionTab();
      if (!tab?.linkedBrowser) return { ok: false, result: "chatgpt-tab-unavailable" };

      gBrowser.selectedTab = tab;
      try {
        window.focus();
      } catch (_) {}

      let result = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          const global = tab.linkedBrowser.browsingContext?.currentWindowGlobal;
          const actor = global?.getActor?.(ACTOR_NAME);
          if (actor) {
            result = await actor.sendQuery("activateVoice", {});
            if (result?.ok) break;
          }
        } catch (error) {
          result = { ok: false, result: String(error) };
        }
        await new Promise((resolve) => window.setTimeout(resolve, 220));
      }

      Services.prefs.setStringPref(
        "qwqc.hey_tabby.runtime.last_result",
        String(result?.result || "actor-unavailable")
      );
      Services.prefs.setStringPref("qwqc.hey_tabby.runtime.last_activation_ms", String(Date.now()));
      log("activate", result);
      return result || { ok: false, result: "actor-unavailable" };
    }

    function onKeyDown(event) {
      if (
        event.code !== "KeyV" ||
        !event.ctrlKey ||
        !event.altKey ||
        !event.shiftKey ||
        event.metaKey
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      activateVoice().catch((error) => {
        console.error("[Hey Tabby] activation failed", error);
      });
    }

    function init() {
      ensureActor();
      window.addEventListener("keydown", onKeyDown, true);
      cleanup.push(() => window.removeEventListener("keydown", onKeyDown, true));
      Services.prefs.setBoolPref("qwqc.hey_tabby.runtime.loaded", true);
      Services.prefs.setStringPref("qwqc.hey_tabby.runtime.version", VERSION);
      log("initialized");
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const fn of cleanup.splice(0).reverse()) {
        try { fn(); } catch (_) {}
      }
      if (actorRegisteredHere) {
        try {
          ChromeUtils.unregisterWindowActor(ACTOR_NAME);
        } catch (_) {}
      }
      Services.prefs.setBoolPref("qwqc.hey_tabby.runtime.loaded", false);
      if (window[INSTANCE_KEY]?.destroy === destroy) delete window[INSTANCE_KEY];
    }

    init();
    return { destroy, activateVoice };
  }

  const start = () => {
    try {
      window[INSTANCE_KEY]?.destroy?.();
      const controller = createController();
      window[INSTANCE_KEY] = controller;
      if (typeof window.addUnloadListener === "function") {
        window.addUnloadListener(() => controller.destroy());
      }
    } catch (error) {
      console.error("[Hey Tabby] failed to initialize", error);
    }
  };

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
})();
