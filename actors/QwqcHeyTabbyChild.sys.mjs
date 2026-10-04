export class QwqcHeyTabbyChild extends JSWindowActorChild {
  static labelFor(element) {
    if (!element) return "";
    return [
      element.getAttribute?.("aria-label") || "",
      element.getAttribute?.("title") || "",
      element.getAttribute?.("data-testid") || "",
      element.textContent || "",
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  findVoiceControl() {
    const document = this.document;
    if (!document) return { active: false, button: null };

    const elements = Array.from(
      document.querySelectorAll(
        'button, [role="button"], [data-testid*="voice"], [aria-label*="voice" i], [aria-label*="stimm" i], [aria-label*="sprach" i]'
      )
    );

    const candidates = elements
      .filter((element) => {
        const rect = element.getBoundingClientRect?.();
        return !rect || (rect.width > 0 && rect.height > 0);
      })
      .map((element) => ({
        element,
        label: QwqcHeyTabbyChild.labelFor(element),
      }));

    const active = candidates.find(({ label }) =>
      /((end|stop|leave|exit|close).*(voice|sprach|stimm))|((voice|sprach|stimm).*(end|stop|leave|exit|close))/.test(label)
    );
    if (active) return { active: true, button: null };

    const exact = candidates.find(({ label }) =>
      /(start voice mode|open voice mode|enter voice mode|voice mode|sprachmodus|stimmenmodus)/.test(label)
    );
    if (exact) return { active: false, button: exact.element };

    const semantic = candidates.find(({ label }) =>
      /(voice|sprach|stimm)/.test(label) &&
      !/(dictat|transcrib|speech to text|microphone|mic|stop|end|leave|exit|close)/.test(label)
    );
    return { active: false, button: semantic?.element || null };
  }

  async activateVoice() {
    for (let attempt = 0; attempt < 15; attempt++) {
      const match = this.findVoiceControl();
      if (match.active) {
        return { ok: true, result: "already-active" };
      }
      if (match.button) {
        try {
          match.button.focus?.({ preventScroll: true });
        } catch (_) {}
        match.button.click();
        return { ok: true, result: "clicked" };
      }
      await new Promise((resolve) => this.contentWindow.setTimeout(resolve, 160));
    }
    return { ok: false, result: "voice-button-not-found" };
  }

  async receiveMessage(message) {
    if (message.name === "activateVoice") {
      return this.activateVoice();
    }
    return { ok: false, result: "unknown-message" };
  }
}
