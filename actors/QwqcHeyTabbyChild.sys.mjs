export class QwqcHeyTabbyChild extends JSWindowActorChild {
  static labelFor(element) {
    if (!element) return "";
    return [
      element.getAttribute?.("aria-label") || "",
      element.getAttribute?.("title") || "",
      element.getAttribute?.("data-testid") || "",
      element.textContent || "",
    ].join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  candidates() {
    const document = this.document;
    if (!document) return [];
    return Array.from(document.querySelectorAll(
      'button, [role="button"], a, [data-testid*="voice"], [aria-label*="voice" i], [aria-label*="stimm" i], [aria-label*="sprach" i]'
    )).filter((element) => {
      const style = this.contentWindow.getComputedStyle(element);
      const rect = element.getBoundingClientRect?.();
      return style?.display !== "none" && style?.visibility !== "hidden" && (!rect || (rect.width > 0 && rect.height > 0));
    }).map(element => ({ element, label: QwqcHeyTabbyChild.labelFor(element) }));
  }

  state() {
    const entries = this.candidates();
    const href = this.document?.location?.href || "";
    const loggedOut = entries.some(({ label, element }) => {
      const link = element.getAttribute?.("href") || "";
      return /^(log in|login|sign up|sign up for free|log in or create account)$/.test(label) || /\/auth\/login/.test(link);
    });
    const activeControl = entries.find(({ label }) =>
      /((end|stop|leave|exit|close).*(voice|sprach|stimm))|((voice|sprach|stimm).*(end|stop|leave|exit|close))/.test(label)
    );
    const startControl = entries.find(({ label, element }) => {
      const link = element.getAttribute?.("href") || "";
      return label === "start voice" ||
        /(start|open|enter|begin).*(voice|sprach|stimm)/.test(label) ||
        /[?&]mode=voice(?:$|&)/.test(link);
    });
    const active = Boolean(activeControl) || /[?&]mode=voice(?:$|&)/.test(href);
    return {
      active,
      ready: Boolean(startControl),
      loggedOut,
      href,
      title: this.document?.title || "",
      activeControl: activeControl?.element || null,
      startControl: startControl?.element || null,
    };
  }

  trustedClick(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const x = Math.max(1, rect.left + rect.width / 2);
    const y = Math.max(1, rect.top + rect.height / 2);
    try {
      const utils = this.contentWindow.windowUtils;
      utils.sendMouseEvent("mousemove", x, y, 0, 0, 0);
      utils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
      utils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
      return true;
    } catch (_) {
      try {
        element.focus?.({ preventScroll: true });
        element.click();
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  async waitForActive(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.state();
      if (state.active) return state;
      await new Promise(resolve => this.contentWindow.setTimeout(resolve, 180));
    }
    return this.state();
  }

  async activateVoice() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = this.state();
      if (state.active) return { ok: true, result: "already-active", active: true, href: state.href };
      if (state.startControl) {
        if (!this.trustedClick(state.startControl))
          return { ok: false, result: "voice-click-failed", active: false, href: state.href };
        const after = await this.waitForActive();
        return {
          ok: after.active,
          result: after.active ? "active" : "voice-did-not-start",
          active: after.active,
          ready: after.ready,
          loggedOut: after.loggedOut,
          href: after.href,
          title: after.title,
        };
      }
      await new Promise(resolve => this.contentWindow.setTimeout(resolve, 180));
    }
    const state = this.state();
    return { ok: false, result: state.loggedOut ? "needs-login" : "voice-button-not-found", active: state.active, ready: state.ready, loggedOut: state.loggedOut, href: state.href };
  }

  async endVoice() {
    const state = this.state();
    if (!state.active) return { ok: true, result: "already-inactive", active: false, href: state.href };
    if (state.activeControl) this.trustedClick(state.activeControl);
    await new Promise(resolve => this.contentWindow.setTimeout(resolve, 300));
    const after = this.state();
    return { ok: !after.active, result: after.active ? "end-click-failed" : "ended", active: after.active, href: after.href };
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "activateVoice": return this.activateVoice();
      case "endVoice": return this.endVoice();
      case "voiceStatus": {
        const state = this.state();
        return { ok: true, result: "status", active: state.active, ready: state.ready, loggedOut: state.loggedOut, href: state.href, title: state.title };
      }
      default: return { ok: false, result: "unknown-message" };
    }
  }
}
